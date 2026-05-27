const express = require('express')
const cors = require('cors')
const dotenv = require('dotenv')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
dotenv.config()

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)



const app = express()
const port = process.env.PORT || 3000

// middleware
app.use(cors())
app.use(express.json())

// Mongo URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@proli.vjehpyn.mongodb.net/?appName=ProLi`

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
})

async function run() {
    try {
        await client.connect()

        // =========================
        // COLLECTIONS
        // =========================
        const petsCollection = client.db('petnest').collection('pets')
        const adoptionRequestsCollection = client.db('petnest').collection('adoptionRequests')
        const donationCollection = client.db('petnest').collection('donations')
        const donationPayments = client.db('petnest').collection('donationsPayments')

        // =========================
        // PETS API
        // =========================
        app.get('/pets', async (req, res) => {
            const email = req.query.email
            const query = email ? { ownerEmail: email } : {}

            const result = await petsCollection.find(query).toArray()
            res.send(result)
        })

        app.get('/pets/:id', async (req, res) => {
            const id = req.params.id
            const result = await petsCollection.findOne({
                _id: new ObjectId(id),
            })
            res.send(result)
        })

        app.post('/pets', async (req, res) => {
            const result = await petsCollection.insertOne(req.body)
            res.send(result)
        })

        app.delete('/pets/:id', async (req, res) => {
            const result = await petsCollection.deleteOne({
                _id: new ObjectId(req.params.id),
            })
            res.send(result)
        })

        // =========================
        // DONATION CAMPAIGNS API
        // =========================
        app.get('/donations', async (req, res) => {
            const email = req.query.email

            const query = email ? { createdByEmail: email } : {}

            const result = await donationCollection.find(query).toArray()

            res.send(result)
        })

        app.get('/donations/:id', async (req, res) => {
            try {
                const result = await donationCollection.findOne({
                    _id: new ObjectId(req.params.id),
                })

                res.send(result)
            } catch (err) {
                res.status(500).send({ message: 'Campaign fetch failed' })
            }
        })

        app.patch('/donations/:id', async (req, res) => {
            const { amount } = req.body

            const result = await donationCollection.updateOne(
                { _id: new ObjectId(req.params.id) },
                {
                    $inc: {
                        donatedAmount: amount,
                    },
                }
            )

            res.send(result)
        })

        // =========================
        // STRIPE PAYMENT
        // =========================
        app.post('/create-payment-intent', async (req, res) => {
            try {
                const { amount } = req.body

                if (!amount || amount <= 0) {
                    return res.status(400).send({ message: 'Invalid amount' })
                }

                const paymentIntent = await stripe.paymentIntents.create({
                    amount: parseInt(amount * 100),
                    currency: 'usd',
                    payment_method_types: ['card'],
                })

                res.send({
                    clientSecret: paymentIntent.client_secret,
                })
            } catch (error) {
                res.status(500).send({ message: 'Stripe error' })
            }
        })

        // =========================
        // SAVE DONATION PAYMENT LOG
        // =========================
        app.post('/donations-payment', async (req, res) => {
            const payment = req.body

            const result = await donationPayments.insertOne({
                ...payment,
                createdAt: new Date()
            })

            res.send(result)
        })

        // =========================
        // ADOPTION REQUEST API
        // =========================

        app.post('/adoption-requests', async (req, res) => {
            try {

                const adoptionData = req.body

                // Check pet exists
                const pet = await petsCollection.findOne({
                    _id: new ObjectId(adoptionData.petId),
                })

                // Prevent adopted pet request
                if (pet.adopted) {
                    return res.status(400).send({
                        message: 'Pet already adopted',
                    })
                }

                // Prevent duplicate request
                const alreadyRequested =
                    await adoptionRequestsCollection.findOne({
                        petId: adoptionData.petId,
                        adopterEmail: adoptionData.adopterEmail,
                    })

                if (alreadyRequested) {
                    return res.status(400).send({
                        message: 'You already requested this pet',
                    })
                }

                const result = await adoptionRequestsCollection.insertOne({
                    ...adoptionData,
                    status: 'Pending',
                    createdAt: new Date(),
                })

                res.send(result)

            } catch (error) {

                res.status(500).send({
                    message: 'Failed to submit adoption request',
                })
            }
        })

        app.get('/adoption-requests', async (req, res) => {

            const email = req.query.email

            const query = {
                ownerEmail: email,
            }

            const result = await adoptionRequestsCollection
                .find(query)
                .toArray()

            res.send(result)
        })

        // Accept or Reject Adoption
        app.patch('/adoption-requests/:id', async (req, res) => {

            const { status, petId } = req.body

            const result = await adoptionRequestsCollection.updateOne(
                {
                    _id: new ObjectId(req.params.id),
                },
                {
                    $set: { status },
                }
            )

            // If accepted -> mark pet adopted
            if (status === 'Accepted') {

                await petsCollection.updateOne(
                    {
                        _id: new ObjectId(petId),
                    },
                    {
                        $set: {
                            adopted: true,
                        },
                    }
                )
            }

            res.send(result)
        })

        // Get Personal Campaigns
        app.get('/my-campaigns', async (req, res) => {

            const email = req.query.email

            const result = await donationsCampaigns
                .find({
                    createdByEmail: email,
                })
                .toArray()

            res.send(result)
        })

        // Get campaign donators
        app.get('/campaign-donators', async (req, res) => {
            const email = req.query.email

            const result = await donationPayments.find({
                campaignOwnerEmail: email
            }).toArray()

            res.send(result)
        })

        // Pause/Resume campaigns

        app.patch('/donations/pause/:id', async (req, res) => {
            const result = await donationCollection.updateOne(
                { _id: new ObjectId(req.params.id) },
                { $set: { status: 'Paused' } }
            )

            res.send(result)
        })

        app.patch('/donations/resume/:id', async (req, res) => {
            const result = await donationCollection.updateOne(
                { _id: new ObjectId(req.params.id) },
                { $set: { status: 'Active' } }
            )

            res.send(result)
        })

        // Add Donations
        app.post('/donations', async (req, res) => {
            try {
                const campaign = req.body

                const result = await donationCollection.insertOne({
                    ...campaign,
                    donatedAmount: 0,
                    status: 'Active',
                    createdAt: new Date()
                })

                res.send(result)
            } catch (err) {
                res.status(500).send({ message: 'Failed to create campaign' })
            }
        })
        // ping
        await client.db('admin').command({ ping: 1 })
        console.log('MongoDB connected')
    } finally {
        // keep alive
    }
}

run().catch(console.dir)

app.get('/', (req, res) => {
    res.send('Petnest running')
})

app.listen(port, () => {
    console.log(`Server running on ${port}`)
})