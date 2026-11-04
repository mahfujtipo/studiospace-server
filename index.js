
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import cors from 'cors';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 8000;

app.use(cors({
    origin: process.env.CLIENT_URI,
    credentials: true
}));

app.use(express.json({ limit: '1mb' }));

// JWT Configuration
if (!process.env.CLIENT_URI) {
    throw new Error('CLIENT_URI is missing from environment variables');
}

const JWKS = createRemoteJWKSet(
    new URL(`${process.env.CLIENT_URI}/api/auth/jwks`)
);

// JWT Verification Middleware
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            message: 'Unauthorized'
        });
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({
            message: 'Unauthorized'
        });
    }

    try {
        const { payload } = await jwtVerify(token, JWKS);

        if (!payload.email || typeof payload.email !== 'string') {
            return res.status(401).json({
                message: 'Invalid user token'
            });
        }

        req.user = payload;

        next();

    } catch (error) {
        console.error('JWT verification error:', error);

        return res.status(401).json({
            message: 'Invalid or expired token'
        });
    }
};

if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing from environment variables');
}

const client = new MongoClient(process.env.MONGODB_URI);

let connectionPromise;

export async function connectToMongoDB() {
    if (!connectionPromise) {
        connectionPromise = client.connect().catch((err) => {
            connectionPromise = null;
            throw err;
        });
    }

    try {
        await connectionPromise;
        console.log('You successfully connected to MongoDB!');
        return client;
    } catch (err) {
        console.error('MongoDB connection failed:', err);
        throw err;
    }
}

const mongoClient = await connectToMongoDB();

const db = mongoClient.db('Studiospace');

const collection = db.collection('available');
const bookingsCollection = db.collection('bookings');

function getBookingDateTime(date, time) {
    return new Date(`${date}T${time}:00+06:00`);
}

function isValidBookingDate(date) {
    if (typeof date !== 'string') return false;

    const datePattern = /^\d{4}-\d{2}-\d{2}$/;

    if (!datePattern.test(date)) return false;

    const parsedDate = new Date(`${date}T00:00:00Z`);

    return (
        !isNaN(parsedDate.getTime()) &&
        parsedDate.toISOString().slice(0, 10) === date
    );
}

function isValidBookingTime(time) {
    return (
        typeof time === 'string' &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(time)
    );
}

function isValidObjectId(id) {
    return typeof id === 'string' && ObjectId.isValid(id);
}

function isValidNumber(value, min = 0) {
    const number = Number(value);

    return Number.isFinite(number) && number >= min;
}

async function refreshStudioStatus(studioId) {
    const now = new Date();

    const bookings = await bookingsCollection.find({
        studioId,
        status: { $in: ['pending', 'confirmed'] }
    }).toArray();

    const hasRemainingBooking = bookings.some((booking) => {
        if (
            !isValidBookingDate(booking.bookingDate) ||
            !isValidBookingTime(booking.endTime)
        ) {
            return false;
        }

        return getBookingDateTime(
            booking.bookingDate,
            booking.endTime
        ) > now;
    });

    await collection.updateOne(
        { _id: studioId },
        {
            $set: {
                status: hasRemainingBooking ? 'booked' : 'available'
            }
        }
    );

    return hasRemainingBooking ? 'booked' : 'available';
}

app.get('/', (req, res) => {
    res.send('StudioSpace Backend is running successfully!');
});

app.get('/alldata', async (req, res) => {
    try {
        const spaces = await collection.find().toArray();

        const updatedSpaces = await Promise.all(
            spaces.map(async (studio) => {
                let currentStatus = studio.status || 'available';

                if (currentStatus === 'booked') {
                    currentStatus = await refreshStudioStatus(studio._id);
                }

                return {
                    ...studio,
                    status: currentStatus
                };
            })
        );

        res.status(200).json(updatedSpaces);

    } catch (err) {
        console.error('Fetch all spaces error:', err);

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
        console.error('Fetch spaces error:', err);

        res.status(500).json({
            message: 'Failed to fetch spaces',
            error: err.message
        });
    }
});

app.post('/bookings', verifyToken, async (req, res) => {
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

        if (!isValidObjectId(studioId)) {
            return res.status(400).json({
                message: 'Invalid studio ID'
            });
        }

        if (!isValidBookingDate(bookingDate)) {
            return res.status(400).json({
                message: 'Invalid booking date'
            });
        }

        if (
            !isValidBookingTime(startTime) ||
            !isValidBookingTime(endTime) ||
            startTime >= endTime
        ) {
            return res.status(400).json({
                message: 'Invalid booking time'
            });
        }

        const studioObjectId = new ObjectId(studioId);

        const studio = await collection.findOne({
            _id: studioObjectId
        });

        if (!studio) {
            return res.status(404).json({
                message: 'Studio not found'
            });
        }

        const existingBooking = await bookingsCollection.findOne({
            studioId: studioObjectId,
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
            userEmail: req.user.email,
            studioId: studioObjectId,
            status: 'pending',
            createdAt: new Date()
        };

        const result = await bookingsCollection.insertOne(booking);

        await refreshStudioStatus(studioObjectId);

        res.status(201).json({
            success: true,
            message: 'Booking successful',
            insertedId: result.insertedId
        });

    } catch (err) {
        console.error('Create booking error:', err);

        res.status(500).json({
            success: false,
            message: 'Booking failed',
            error: err.message
        });
    }
});

app.get('/bookings/my-bookings', verifyToken, async (req, res) => {
    try {
        const userEmail = req.user.email;

        const now = new Date();

        const bookings = await bookingsCollection.find({
            userEmail
        }).toArray();

        const expiredBookingIds = [];
        const activeBookings = [];

        for (const booking of bookings) {
            if (
                !isValidBookingDate(booking.bookingDate) ||
                !isValidBookingTime(booking.endTime)
            ) {
                activeBookings.push(booking);
                continue;
            }

            const bookingEnd = getBookingDateTime(
                booking.bookingDate,
                booking.endTime
            );

            if (now > bookingEnd) {
                expiredBookingIds.push(booking._id);
            } else {
                activeBookings.push(booking);
            }
        }

        if (expiredBookingIds.length > 0) {
            await bookingsCollection.deleteMany({
                _id: { $in: expiredBookingIds },
                userEmail
            });

            const affectedStudioIds = [
                ...new Map(
                    bookings
                        .filter((booking) =>
                            expiredBookingIds.some(
                                (id) => id.equals(booking._id)
                            )
                        )
                        .map((booking) => [
                            booking.studioId.toString(),
                            booking.studioId
                        ])
                ).values()
            ];

            await Promise.all(
                affectedStudioIds.map((studioId) =>
                    refreshStudioStatus(studioId)
                )
            );
        }

        res.status(200).json(activeBookings);

    } catch (err) {
        console.error('Fetch user bookings error:', err);

        res.status(500).json({
            message: 'Failed to fetch user bookings',
            error: err.message
        });
    }
});

app.post('/studios', verifyToken, async (req, res) => {
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
            userName
        } = req.body;

        if (
            !studioName ||
            typeof studioName !== 'string' ||
            !location ||
            typeof location !== 'string' ||
            pricePerHour === undefined ||
            pricePerHour === null ||
            pricePerHour === ''
        ) {
            return res.status(400).json({
                success: false,
                message: 'Please provide all required fields'
            });
        }

        if (
            !isValidNumber(pricePerHour) ||
            !isValidNumber(securityDeposit ?? 500) ||
            !isValidNumber(maxCapacity ?? 5, 1) ||
            !Number.isInteger(Number(maxCapacity ?? 5))
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid price, security deposit or capacity'
            });
        }

        const newStudio = {
            title: studioName.trim(),
            category: category || 'General',
            hourlyRate: Number(pricePerHour),
            securityDeposit: Number(securityDeposit ?? 500),
            maxCapacity: Number(maxCapacity ?? 5),
            location: location.trim(),
            overview: description || '',
            imageUrl: image || '',
            amenities: Array.isArray(req.body.amenities) ? req.body.amenities : [],
            ownerEmail: req.user.email,
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
        console.error('Create studio error:', err);

        res.status(500).json({
            success: false,
            message: 'Failed to add studio',
            error: err.message
        });
    }
});

app.get('/studios/my-studios', verifyToken, async (req, res) => {
    try {
        const email = req.user.email;

        const query = {
            $or: [
                { ownerEmail: email },
                { hostEmail: email }
            ]
        };

        const userStudios = await collection.find(query).toArray();

        const updatedStudios = await Promise.all(
            userStudios.map(async (studio) => {
                let currentStatus = studio.status || 'available';

                if (currentStatus === 'booked') {
                    currentStatus = await refreshStudioStatus(studio._id);
                }

                return {
                    ...studio,
                    status: currentStatus
                };
            })
        );

        res.status(200).json(updatedStudios);

    } catch (err) {
        console.error('Error fetching user studios:', err);

        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

app.put('/studios/:id', verifyToken, async (req, res) => {
    try {
        const studioId = req.params.id;

        if (!isValidObjectId(studioId)) {
            return res.status(400).json({
                message: 'Invalid studio ID format'
            });
        }

        const updatedData = req.body;
        const updateFields = {};

        if (updatedData.title !== undefined) {
            if (
                typeof updatedData.title !== 'string' ||
                !updatedData.title.trim()
            ) {
                return res.status(400).json({
                    message: 'Invalid studio title'
                });
            }

            updateFields.title = updatedData.title.trim();
        }

        if (updatedData.category !== undefined) {
            updateFields.category = updatedData.category;
        }

        if (updatedData.hourlyRate !== undefined) {
            if (!isValidNumber(updatedData.hourlyRate)) {
                return res.status(400).json({
                    message: 'Invalid hourly rate'
                });
            }

            updateFields.hourlyRate = Number(updatedData.hourlyRate);
        }

        if (updatedData.securityDeposit !== undefined) {
            if (!isValidNumber(updatedData.securityDeposit)) {
                return res.status(400).json({
                    message: 'Invalid security deposit'
                });
            }

            updateFields.securityDeposit = Number(
                updatedData.securityDeposit
            );
        }

        if (updatedData.maxCapacity !== undefined) {
            if (
                !isValidNumber(updatedData.maxCapacity, 1) ||
                !Number.isInteger(Number(updatedData.maxCapacity))
            ) {
                return res.status(400).json({
                    message: 'Invalid maximum capacity'
                });
            }

            updateFields.maxCapacity = Number(updatedData.maxCapacity);
        }

        if (updatedData.location !== undefined) {
            updateFields.location = updatedData.location;
        }

        if (updatedData.imageUrl !== undefined) {
            updateFields.imageUrl = updatedData.imageUrl;
        }

        if (updatedData.amenities !== undefined) {
            if (!Array.isArray(updatedData.amenities)) {
                return res.status(400).json({
                    message: 'Amenities must be an array'
                });
            }

            updateFields.amenities = updatedData.amenities;
        }

        if (updatedData.description !== undefined) {
            updateFields.overview = updatedData.description;
        }

        if (Object.keys(updateFields).length === 0) {
            return res.status(400).json({
                message: 'No valid fields provided for update'
            });
        }

        updateFields.updatedAt = new Date();

        const query = {
            _id: new ObjectId(studioId),
            $or: [
                { ownerEmail: req.user.email },
                { hostEmail: req.user.email }
            ]
        };

        const updateDoc = {
            $set: updateFields
        };

        const result = await collection.updateOne(query, updateDoc);

        if (result.matchedCount === 0) {
            return res.status(404).json({
                message: 'Studio not found'
            });
        }

        res.status(200).json({
            message: 'Studio updated successfully',
            result
        });

    } catch (err) {
        console.error('Update studio error:', err);

        res.status(500).json({
            message: 'Failed to update studio',
            error: err.message
        });
    }
});

app.delete('/studios/:id', verifyToken, async (req, res) => {
    try {
        const id = req.params.id;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid studio ID'
            });
        }

        const query = {
            _id: new ObjectId(id),
            $or: [
                { ownerEmail: req.user.email },
                { hostEmail: req.user.email }
            ]
        };

        const result = await collection.deleteOne(query);

        if (result.deletedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Studio not found'
            });
        }

        res.status(200).json({
            success: true,
            message: 'Studio deleted successfully'
        });

    } catch (err) {
        console.error('Error deleting studio:', err);

        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

app.get('/studios/:id', async (req, res) => {
    try {
        const id = req.params.id;

        if (!isValidObjectId(id)) {
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
            currentStatus = await refreshStudioStatus(studio._id);
        }

        res.status(200).json({
            ...studio,
            status: currentStatus
        });

    } catch (err) {
        console.error('Fetch single studio error:', err);

        res.status(500).json({
            message: 'Failed to fetch studio',
            error: err.message
        });
    }
});

app.delete('/bookings/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const email = req.user.email;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid booking ID'
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

        if (
            !isValidBookingDate(bookingDate) ||
            !isValidBookingTime(startTime) ||
            !isValidBookingTime(endTime) ||
            startTime >= endTime
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid booking date or time'
            });
        }

        const bookingStart = getBookingDateTime(
            bookingDate,
            startTime
        );

        const bookingEnd = getBookingDateTime(
            bookingDate,
            endTime
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

        await refreshStudioStatus(booking.studioId);

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

if (process.env.VERCEL !== '1') {
    app.listen(port, () => {
        console.log(`Server is running smoothly on port ${port}`);
    });
}

export default app;
