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

// Create Booking
// Create Booking
app.post('/bookings', async (req, res) => {
    console.log("BACKEND RECEIVED BODY:", req.body);
    try {
        // ফ্লেক্সিবল করা হলো যাতে id বা studioId দুটোই কাজ করে
        const studioId = req.body.studioId || req.body.id;
        const {
            bookingDate,
            startTime,
            endTime
        } = req.body;

        // Input validation
        if (!studioId || !bookingDate || !startTime || !endTime) {
            return res.status(400).json({
                message: 'Please provide all required information'
            });
        }

        if (!ObjectId.isValid(studioId)) {
            return res.status(400).json({
                message: 'Invalid studio ID'
            });
        }

        // Validate date
        const datePattern = /^\d{4}-\d{2}-\d{2}$/;
        const date = new Date(`${bookingDate}T00:00:00Z`);

        if (
            !datePattern.test(bookingDate) ||
            isNaN(date.getTime()) ||
            date.toISOString().slice(0, 10) !== bookingDate
        ) {
            return res.status(400).json({
                message: 'Invalid booking date'
            });
        }

        // Validate time
        const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

        if (
            !timePattern.test(startTime) ||
            !timePattern.test(endTime) ||
            startTime >= endTime
        ) {
            return res.status(400).json({
                message: 'Invalid booking time'
            });
        }

        // Check if studio exists
        const studio = await collection.findOne({
            _id: new ObjectId(studioId)
        });

        if (!studio) {
            return res.status(404).json({
                message: 'Studio not found'
            });
        }

        // Check time-slot conflict
        const existingBooking = await bookingsCollection.findOne({
            studioId: new ObjectId(studioId),
            bookingDate,
            status: { $in: ['pending', 'confirmed'] },
            startTime: { $lt: endTime },
            endTime: { $gt: startTime }
        });

        if (existingBooking) {
            return res.status(409).json({
                message: 'This time slot is already booked'
            });
        }

        // Save booking
        const booking = {
            ...req.body,
            studioId: new ObjectId(studioId), // সঠিক অবজেক্টআইডি ফরম্যাটে সেভ হবে
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
            message: 'Booking failed',
            error: err.message
        });
    }
})
app.get('/bookings/my-bookings', async (req, res) => {
    try {
        const userEmail = req.query.email;

        let query = {};
        if (userEmail) {
            query = { userEmail: userEmail };
        }
        const bookings = await bookingsCollection.find(query).toArray();

        res.status(200).json(bookings);
    } catch (err) {
        console.error(err);
        res.status(500).json({
            message: 'Failed to fetch user bookings',
            error: err.message
        });
    }
});
app.listen(port, () => {
    console.log(`Example app listening on port ${port} `)
})