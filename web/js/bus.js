// WebSocket link to the engine, with automatic reconnects.

export class Bus {
  constructor(role, handlers, onStatus = () => {}) {
    this.role = role;
    this.handlers = handlers;
    this.onStatus = onStatus;
    this.attempts = 0;
    this.connect();
  }

  connect() {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      socket.send(JSON.stringify({ type: "hello", role: this.role }));
      this.onStatus(true);
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.handlers[message.type]?.(message);
    };
    socket.onclose = () => {
      this.onStatus(false);
      const delay = Math.min(10000, 500 * 2 ** this.attempts++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}
