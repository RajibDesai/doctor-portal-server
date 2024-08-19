const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId, Transaction } = require('mongodb');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const port = process.env.PORT || 5000;

const app = express();

// middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0-shard-00-00.mkdal.mongodb.net:27017,cluster0-shard-00-01.mkdal.mongodb.net:27017,cluster0-shard-00-02.mkdal.mongodb.net:27017/?ssl=true&replicaSet=atlas-f0gjnq-shard-0&authSource=admin&retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

function verifyJWT(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send('unauthorized access');
    }

    const token = authHeader.split(' ')[1];

    jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'forbidden access' })
        }
        req.decoded = decoded;
        next();
    })
}

async function run() {
    try {
        const appointOptionCollection = client.db('Doctors-Portal').collection('Appointment-Options');
        const bookingsCollection = client.db('Doctors-Portal').collection('bookings');
        const usersCollection = client.db('Doctors-Portal').collection('users');
        const doctorsCollection = client.db('Doctors-Portal').collection('doctors');
        const paymentsCollection = client.db('Doctors-Portal').collection('payments');

        // Note: Make sure you want verifyAdmin after verifyJWT
        const verifyAdmin = async (req, res, next) => {
            // console.log('inside verifyAdmin', req.decoded.email)

            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail }
            const user = await usersCollection.findOne(query);
            console.log(user);

            if (user?.role !== 'admin') {
                return res.status(403).send({ message: "forbidden access" })
            }
            next()
        }

        // AvailableAppointment
        app.get('/appointmentOptions', async (req, res) => {
            const date = req.query.date;
            const query = {}
            const AppointOptions = await appointOptionCollection.find(query).toArray();
            const bookingOptionQuery = { appointmentDate: date }
            const alreadyBookedOption = await bookingsCollection.find(bookingOptionQuery).toArray();
            AppointOptions.forEach(AppointOption => {
                const optionsBooked = alreadyBookedOption.filter(optionBook => optionBook.treatment === AppointOption.name);
                const bookedSlotes = optionsBooked.map(book => book.slot);
                const remainingSlots = AppointOption.slots.filter(slot => !bookedSlotes.includes(slot));
                AppointOption.slots = remainingSlots;
                console.log('Option', date, AppointOption.name, remainingSlots.length)
            })
            res.send(AppointOptions);
        })

        app.get('/v2/appointmentOptions', async (req, res) => {
            const date = req.query.date;
            const options = await appointOptionCollection.aggregate([
                {
                    $lookup: {
                        from: 'bookings',
                        localField: 'name',
                        foreignField: 'treatment',
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $eq: ['$appointmentDate', date]
                                    }
                                }
                            }
                        ],
                        as: 'booked'
                    }
                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: 1,
                        booked: {
                            $map: {
                                input: '$booked',
                                as: 'book',
                                in: '$$book.slot'
                            }
                        }
                    }
                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: {
                            $setDifference: ['$slots', '$booked']
                        }
                    }
                }
            ]).toArray();
            res.send(options);
        });

        // AddDoctors
        app.get('/appointmentSpecialty', async (req, res) => {
            const query = {}
            const result = await appointOptionCollection.find(query).project({ name: 1 }).toArray()
            res.send(result)
        })

        // MyAppointment
        app.get('/bookings', verifyJWT, async (req, res) => {
            const email = req.query.email;
            const decodedEmail = req.decoded.email;

            if (email !== decodedEmail) {
                return res.status(403).send({ message: 'forbidden access' })
            }

            const query = { email: email };
            const bookings = await bookingsCollection.find(query).toArray();
            res.send(bookings);
        });

        app.get('/bookings/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const booking = await bookingsCollection.findOne(query);
            res.send(booking);
        })

        // BookingModal
        app.post('/bookings', async (req, res) => {
            const booking = req.body;
            console.log('Booking', booking);
            const query = {
                appointmentDate: booking.appointmentDate,
                email: booking.email,
                treatment: booking.treatment
            }

            const alreadyBooked = await bookingsCollection.find(query).toArray();

            if (alreadyBooked.length) {
                const message = `You already have a booking on ${booking.appointmentDate}`
                return res.send({ acknowledged: false, message })
            }
            const result = await bookingsCollection.insertOne(booking);
            res.send(result);
        });

        // CheckOutForm
        app.post('/create-payment-intent', async (req, res) => {
            const booking = req.body;
            const price = booking.price;
            const amount = price * 100;

            const paymentIntent = await stripe.paymentIntents.create({
                currency: "usd",
                amount: amount,
                "payment_method_types": [
                    "card",
                ]
            });
            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        });

        // CheckOutForm
        app.post('/payments', async (req, res) => {
            const payment = req.body;
            const result = await paymentsCollection.insertOne(payment);
            const id = payment.bookingId
            const filter = { _id: new ObjectId(id) }
            const updatedDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                }
            }
            const updateResult = await bookingsCollection.updateOne(filter,updatedDoc)
            res.send(result);
        })

        // useToken
        app.get('/jwt', async (req, res) => {
            const email = req.query.email;
            const query = { email: email };
            const user = await usersCollection.findOne(query);
            if (user) {
                const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '4h' });
                return res.send({ accassToken: token })
            }
            console.log('user1', user);
            res.status(403).send({ accassToken: "You have No AccessToken" })
        });

        // useAdmin
        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await usersCollection.findOne(query);
            res.send({ isAdmin: user?.role === "admin" })
        })

        // Signup -> save user's name and email mongodb
        app.post('/users', async (req, res) => {
            const user = req.body;
            console.log('user2', user)
            const result = await usersCollection.insertOne(user);
            res.send(result);
        })

        // AllUsers
        app.get('/users', async (req, res) => {
            const query = {}
            const users = await usersCollection.find(query).toArray();
            res.send(users);
        });

        // AllUsers
        app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) }
            const options = { upsert: true };
            const updatedDoc = {
                $set: {
                    role: "admin"
                }
            }
            const result = await usersCollection.updateOne(filter, updatedDoc, options);
            res.send(result);
        });

        // Temporary update price field on apointment options

        // app.get('/addPrice', async (req, res) => {
        //     const filter = {}
        //     const options = { upsert: true }
        //     const updatedDoc = {
        //         $set: {
        //             price: 99
        //         }
        //     }
        //     const result = await appointOptionCollection.updateMany(filter,updatedDoc,options)
        //     res.send(result);
        // })

        // ManageDoctors
        app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const query = {}
            const doctors = await doctorsCollection.find(query).toArray()
            res.send(doctors)
        });

        // AddDoctors
        app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorsCollection.insertOne(doctor);
            res.send(result);
        });

        // ManageDoctors
        app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) }
            const result = await doctorsCollection.deleteOne(filter)
            res.send(result)
        })

    } finally {

    }
}
run().catch(console.log);

app.get('/', (req, res) => {
    res.send('doctors portal server is running')
})

app.listen(port, () => {
    console.log(`doctors portal running on ${port}`);
})