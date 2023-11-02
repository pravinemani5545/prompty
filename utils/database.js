import mongoose from 'mongoose';

let isConnected = false; // track the connection

export const connectToDB = async () => {
  mongoose.set('strictQuery', true);

  if(isConnected) {
    console.log('MongoDB is already connected');
    return;
  }

  try {
    await mongoose.connect("mongodb+srv://pravinemani:NyyFMYw8zErLOwz6@cluster0.jfddoh7.mongodb.net/promptopia?retryWrites=true&w=majority", {
      dbName: "Promptopia",
      useNewUrlParser: true,
      useUnifiedTopology: true,
    })

    isConnected = true;

    console.log('MongoDB connected MONGO_URI=')
  } catch (error) {
    console.log(error);
  }
}