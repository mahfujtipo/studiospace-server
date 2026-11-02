
import express from 'express';
import { MongoClient } from 'mongodb';
import 'dotenv/config'
const app = express()
const port = 8000
const client = new MongoClient(process.env.MONGODB_URI);
export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}
const mongoClient = await connectToMongoDB();
const db = mongoClient.db('Studiospace');
const collection = db.collection('available');
app.get('/', (req, res) => {
    res.send('Hello World!')
})
app.get('/alldata', async (req, res) => {
    try {
        const spaces = await collection.find().toArray();

        res.status(200).json(spaces);
    } catch (err) {
        console.error(err);

        res.status(500).json({
            message: 'Failed to fetch data',
            error: err.message
        });
    }
})
app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})