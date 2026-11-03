import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import cors from 'cors';
import 'dotenv/config';

const app = express();
const port = 8000;

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
    res.send('Hello World!');
});

app.get('/alldata', async (req, res) => {
    try {
        const now = new Date();
        const spaces = await collection.find().toArray();

        const updatedSpaces = await Promise.all(spaces.map(async (studio) => {
            if (studio.status === 'booked') {
                const activeBooking = await bookingsCollection.findOne({
                    studioId: studio._id,
                    status: { $in: ['pending', 'confirmed'] }
                });

                if (activeBooking) {
                    const bookingEndDateTime = new Date(`${activeBooking.bookingDate}T${activeBooking.endTime}:00Z`);
                    if (now > bookingEndDateTime) {
                        await collection.updateOne({ _id: studio._id }, { $set: { status: 'available' } });
                        return { ...studio, status: 'available' };
                    }
                } else {
                    await collection.updateOne({ _id: studio._id }, { $set: { status: 'available' } });
                    return { ...studio, status: 'available' };
                }
            }
            return { ...studio, status: studio.status || 'available' };
        }));

        res.status(200).json(updatedSpaces);
    } catch (err) {
        console.error(err);
        res.status(500).json({
            message: 'Failed to fetch data',
            error: err.message
        });
    }
});

app.get('/spaces', async (req, res) => {
    try {
        const spaces = await collection.find().toArray();
        res.status(200).json({ spaces });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            message: 'Failed to fetch spaces',
            error: err.message
        });
    }
});

app.post('/bookings', async (req, res) => {
    console.log("BACKEND RECEIVED BODY:", req.body);
    try {
        const studioId = req.body.studioId || req.body.id;
        const {
            bookingDate,
            startTime,
            endTime
        } = req.body;

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

        const studio = await collection.findOne({
            _id: new ObjectId(studioId)
        });

        if (!studio) {
            return res.status(404).json({
                message: 'Studio not found'
            });
        }

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

        const booking = {
            ...req.body,
            studioId: new ObjectId(studioId),
            status: 'pending',
            createdAt: new Date()
        };

        const result = await bookingsCollection.insertOne(booking);

        await collection.updateOne(
            { _id: new ObjectId(studioId) },
            { $set: { status: 'booked' } }
        );

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
});

app.get('/bookings/my-bookings', async (req, res) => {
    try {
        const userEmail = req.query.email;

        let query = {};
        if (userEmail) {
            query = { userEmail: userEmail };
        }

        const now = new Date();
        const bookings = await bookingsCollection.find(query).toArray();

        for (const booking of bookings) {
            const bookingEnd = new Date(`${booking.bookingDate}T${booking.endTime}:00+06:00`);

            if (now > bookingEnd) {
                await bookingsCollection.deleteOne({ _id: booking._id });

                const remainingBooking = await bookingsCollection.findOne({
                    studioId: booking.studioId,
                    status: { $in: ['pending', 'confirmed'] }
                });

                await collection.updateOne(
                    { _id: booking.studioId },
                    { $set: { status: remainingBooking ? 'booked' : 'available' } }
                );
            }
        }

        const activeBookings = bookings.filter(booking => {
            const bookingEnd = new Date(`${booking.bookingDate}T${booking.endTime}:00+06:00`);
            return now <= bookingEnd;
        });

        res.status(200).json(activeBookings);
    } catch (err) {
        console.error(err);
        res.status(500).json({
            message: 'Failed to fetch user bookings',
            error: err.message
        });
    }
});

app.post('/studios', async (req, res) => {
    try {
        const {
            studioName,
            category,
            pricePerHour,
            securityDeposit,
            maxCapacity,
            location,
            description,
            image,
            userEmail,
            userName
        } = req.body;

        if (!studioName || !pricePerHour || !location || !userEmail) {
            return res.status(400).json({
                success: false,
                message: 'Please provide all required fields'
            });
        }

        const newStudio = {
            title: studioName,
            category: category || 'General',
            hourlyRate: Number(pricePerHour),
            securityDeposit: Number(securityDeposit || 500),
            maxCapacity: Number(maxCapacity || 5),
            location,
            overview: description || '',
            imageUrl: image || '',
            ownerEmail: userEmail,
            ownerName: userName || 'Host',
            status: 'available',
            createdAt: new Date()
        };

        const result = await collection.insertOne(newStudio);

        res.status(201).json({
            success: true,
            message: 'Studio added successfully',
            insertedId: result.insertedId
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to add studio',
            error: err.message
        });
    }
});

app.get('/studios/my-studios', async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) {
            return res.status(400).json({ success: false, message: 'Email query parameter is required' });
        }
        const query = { $or: [{ ownerEmail: email }, { hostEmail: email }] };
        const userStudios = await collection.find(query).toArray();

        const now = new Date();
        const updatedStudios = await Promise.all(userStudios.map(async (studio) => {
            if (studio.status === 'booked') {
                const activeBooking = await bookingsCollection.findOne({
                    studioId: studio._id,
                    status: { $in: ['pending', 'confirmed'] }
                });

                if (activeBooking) {
                    const bookingEndDateTime = new Date(`${activeBooking.bookingDate}T${activeBooking.endTime}:00Z`);
                    if (now > bookingEndDateTime) {
                        await collection.updateOne({ _id: studio._id }, { $set: { status: 'available' } });
                        return { ...studio, status: 'available' };
                    }
                } else {
                    await collection.updateOne({ _id: studio._id }, { $set: { status: 'available' } });
                    return { ...studio, status: 'available' };
                }
            }
            return { ...studio, status: studio.status || 'available' };
        }));

        res.status(200).json(updatedStudios);
    } catch (err) {
        console.error('Error fetching user studios:', err);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});
app.put('/studios/:id', async (req, res) => {
    try {
        const studioId = req.params.id;

        if (!ObjectId.isValid(studioId)) {
            return res.status(400).json({ message: "Invalid studio ID format" });
        }

        const updatedData = req.body;

        const query = { _id: new ObjectId(studioId) };
        const updateDoc = {
            $set: {
                title: updatedData.title,
                category: updatedData.category,
                hourlyRate: Number(updatedData.hourlyRate || 0),
                securityDeposit: Number(updatedData.securityDeposit || 0),
                maxCapacity: Number(updatedData.maxCapacity || 1),
                location: updatedData.location,
                imageUrl: updatedData.imageUrl,
                amenities: updatedData.amenities,
                overview: updatedData.description,
                updatedAt: new Date()
            },
        };

        // 'studiosCollection'-এর বদলে আপনার আসল কালেকশন ভেরিয়েবল 'collection' ব্যবহার করা হয়েছে
        const result = await collection.updateOne(query, updateDoc);

        if (result.matchedCount === 0) {
            return res.status(404).json({ message: "Studio not found" });
        }

        res.status(200).json({ message: "Studio updated successfully", result });
    } catch (error) {
        console.error("Update Studio Error:", error);
        res.status(500).json({ message: "Failed to update studio", error: error.message });
    }
});
app.delete('/studios/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await collection.deleteOne(query);

        if (result.deletedCount === 0) {
            return res.status(404).json({ success: false, message: 'Studio not found' });
        }
        res.status(200).json({ success: true, message: 'Studio deleted successfully' });
    } catch (err) {
        console.error('Error deleting studio:', err);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

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

        let currentStatus = studio.status || 'available';
        if (currentStatus === 'booked') {
            const activeBooking = await bookingsCollection.findOne({
                studioId: studio._id,
                status: { $in: ['pending', 'confirmed'] }
            });

            if (activeBooking) {
                const now = new Date();
                const bookingEndDateTime = new Date(`${activeBooking.bookingDate}T${activeBooking.endTime}:00Z`);
                if (now > bookingEndDateTime) {
                    await collection.updateOne({ _id: studio._id }, { $set: { status: 'available' } });
                    currentStatus = 'available';
                }
            } else {
                await collection.updateOne({ _id: studio._id }, { $set: { status: 'available' } });
                currentStatus = 'available';
            }
        }

        res.status(200).json({ ...studio, status: currentStatus });

    } catch (err) {
        console.error(err);
        res.status(500).json({
            message: 'Failed to fetch studio',
            error: err.message
        });
    }
});

app.delete('/bookings/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { email } = req.query;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid booking ID'
            });
        }

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'User email is required'
            });
        }

        const booking = await bookingsCollection.findOne({
            _id: new ObjectId(id),
            userEmail: email
        });

        if (!booking) {
            return res.status(404).json({
                success: false,
                message: 'Booking not found'
            });
        }

        const { bookingDate, startTime, endTime } = booking;

        const datePattern = /^\d{4}-\d{2}-\d{2}$/;
        const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

        if (
            !datePattern.test(bookingDate) ||
            !timePattern.test(startTime) ||
            !timePattern.test(endTime) ||
            startTime >= endTime
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid booking date or time'
            });
        }

        const bookingStart = new Date(
            `${bookingDate}T${startTime}:00+06:00`
        );

        const bookingEnd = new Date(
            `${bookingDate}T${endTime}:00+06:00`
        );

        const now = new Date();

        if (now >= bookingStart && now < bookingEnd) {
            return res.status(403).json({
                success: false,
                message: 'You cannot delete an active booking.'
            });
        }

        const result = await bookingsCollection.deleteOne({
            _id: new ObjectId(id),
            userEmail: email
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Booking not found'
            });
        }

        const remainingBooking = await bookingsCollection.findOne({
            studioId: booking.studioId,
            status: { $in: ['pending', 'confirmed'] }
        });

        await collection.updateOne(
            { _id: booking.studioId },
            {
                $set: {
                    status: remainingBooking ? 'booked' : 'available'
                }
            }
        );

        res.status(200).json({
            success: true,
            message: 'Booking deleted successfully'
        });

    } catch (err) {
        console.error('Booking deletion error:', err);

        res.status(500).json({
            success: false,
            message: 'Failed to delete booking'
        });
    }
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});