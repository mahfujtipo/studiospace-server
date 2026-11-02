
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import cors from 'cors';
import 'dotenv/config'

const app = express()
const port = 8000

app.use(cors({
    origin: 'http://localhost:3000'
}));

app.use(express.json());

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
const bookingsCollection = db.collection('bookings');

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

app.get('/studios/:id', async (req, res) => {
    try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                message: 'Invalid studio ID'
            });
        }

        const studio = await collection.findOne({
            _id: new ObjectId(id)
        });

        if (!studio) {
            return res.status(404).json({
                message: 'Studio not found'
            });
        }

        res.status(200).json(studio);

    } catch (err) {
        console.error(err);

        res.status(500).json({
            message: 'Failed to fetch studio',
            error: err.message
        });
    }
})

app.post('/bookings', async (req, res) => {
    try {
        const booking = {
            ...req.body,
            status: 'pending',
            createdAt: new Date()
        };

        const result = await bookingsCollection.insertOne(booking);

        res.status(201).json({
            success: true,
            message: 'Booking successful',
            insertedId: result.insertedId
        });

    } catch (err) {
        console.error(err);

        res.status(500).json({
            success: false,
            message: 'Booking failed'
        });
    }
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port} `)
})