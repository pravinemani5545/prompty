import { createLogger, errorMessage } from "../log.js";
import type { ChatMessage } from "../types.js";
import type { ChatSource, SourceState } from "./source.js";

const log = createLogger("youtube");
const API = "https://www.googleapis.com/youtube/v3";

interface LiveChatItem {
  id: string;
  snippet: {
    type: string;
    displayMessage?: string;
    textMessageDetails?: { messageText: string };
    superChatDetails?: { amountMicros: string; currency: string; amountDisplayString: string; userComment?: string };
    newSponsorDetails?: { memberLevelName?: string };
  };
  authorDetails: {
    displayName: string;
    channelId: string;
    isChatOwner: boolean;
    isChatModerator: boolean;
    isChatSponsor: boolean;
  };
}

/** Maps a YouTube live chat item to a chat message. Returns null for types we don't answer. */
export function toYouTubeMessage(item: LiveChatItem, now = Date.now()): ChatMessage | null {
  const author = item.authorDetails;
  const base = {
    id: item.id,
    platform: "youtube" as const,
    user: author.displayName,
    userId: author.channelId,
    ts: now,
    badges: { broadcaster: author.isChatOwner, mod: author.isChatModerator, member: author.isChatSponsor },
  };
  const s = item.snippet;
  switch (s.type) {
    case "textMessageEvent":
      return { ...base, text: s.textMessageDetails?.messageText ?? s.displayMessage ?? "" };
    case "superChatEvent": {
      const d = s.superChatDetails;
      if (!d) return null;
      return {
        ...base,
        text: d.userComment ?? "",
        event: "superchat",
        paid: { amount: Number(d.amountMicros) / 1_000_000, currency: d.currency, display: d.amountDisplayString },
        eventText: `${author.displayName} sent a ${d.amountDisplayString} Super Chat`,
      };
    }
    case "newSponsorEvent":
    case "memberMilestoneChatEvent":
      return {
        ...base,
        text: s.displayMessage ?? "",
        event: "member",
        eventText: `${author.displayName} became a member${s.newSponsorDetails?.memberLevelName ? ` (${s.newSponsorDetails.memberLevelName})` : ""}`,
      };
    default:
      return null;
  }
}

/**
 * Polls YouTube live chat through the Data API. Each poll costs quota, so the
 * interval never drops below `minPollSeconds` even if YouTube allows it.
 */
export class YouTubeChat implements ChatSource {
  readonly name: string;
  private currentState: SourceState = "idle";
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: { videoId: string; apiKey?: string; oauthToken?: string; minPollSeconds: number },
  ) {
    if (!options.apiKey && !options.oauthToken) throw new Error("YouTube chat needs YOUTUBE_API_KEY or YOUTUBE_OAUTH_TOKEN");
    this.name = `youtube ${options.videoId}`;
  }

  get state(): SourceState {
    return this.currentState;
  }

  private async get(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const query = new URLSearchParams(params);
    if (!this.options.oauthToken && this.options.apiKey) query.set("key", this.options.apiKey);
    const response = await fetch(`${API}/${path}?${query}`, {
      headers: this.options.oauthToken ? { Authorization: `Bearer ${this.options.oauthToken}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const error = body.error as { message?: string } | undefined;
      throw new Error(`YouTube API ${response.status}: ${error?.message ?? "request failed"}`);
    }
    return body;
  }

  start(onMessage: (message: ChatMessage) => void): void {
    this.stopped = false;
    void this.run(onMessage);
  }

  private async run(onMessage: (message: ChatMessage) => void): Promise<void> {
    this.currentState = "connecting";
    let liveChatId: string | undefined;
    try {
      const video = await this.get("videos", { part: "liveStreamingDetails", id: this.options.videoId });
      const items = video.items as { liveStreamingDetails?: { activeLiveChatId?: string } }[] | undefined;
      liveChatId = items?.[0]?.liveStreamingDetails?.activeLiveChatId;
      if (!liveChatId) throw new Error("no active live chat for that video (is the stream live?)");
    } catch (error) {
      this.currentState = "error";
      log.error(errorMessage(error));
      if (!this.stopped) this.timer = setTimeout(() => void this.run(onMessage), 30_000);
      return;
    }

    log.info(`reading live chat for video ${this.options.videoId}`);
    this.currentState = "connected";
    let pageToken: string | undefined;
    let firstPage = true;
    const poll = async () => {
      if (this.stopped) return;
      let waitMs = this.options.minPollSeconds * 1000;
      try {
        const page = await this.get("liveChat/messages", {
          liveChatId: liveChatId!,
          part: "snippet,authorDetails",
          maxResults: "200",
          ...(pageToken ? { pageToken } : {}),
        });
        pageToken = page.nextPageToken as string | undefined;
        waitMs = Math.max(waitMs, Number(page.pollingIntervalMillis ?? 0));
        // The first page is the backlog from before we connected; skip it.
        if (!firstPage) {
          for (const item of (page.items as LiveChatItem[] | undefined) ?? []) {
            const message = toYouTubeMessage(item);
            if (message) onMessage(message);
          }
        }
        firstPage = false;
        this.currentState = "connected";
      } catch (error) {
        this.currentState = "error";
        log.warn(errorMessage(error));
        waitMs = Math.max(waitMs, 15_000);
      }
      if (!this.stopped) this.timer = setTimeout(() => void poll(), waitMs);
    };
    await poll();
  }

  stop(): void {
    this.stopped = true;
    this.currentState = "stopped";
    clearTimeout(this.timer);
  }
}
