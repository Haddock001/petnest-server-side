const express = require('express');
const cors = require('cors');
const app = express();
const dotenv = require('dotenv');
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config()

// middle ware

app.use(cors());
app.use(express.json());


const uri = `mongodb+srv://${process.env.VITE_DB_USER}:${process.env.VITE_DB_PASSWORD}@proli.vjehpyn.mongodb.net/?appName=ProLi`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});
async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        // find pets api
        const petsCollection = client.db('petnest').collection('pets'); //get pets colllection from db

        app.get('/pets', async (req, res) => {
            const email = req.query.email;
            let query = {};
            if (email) {
                query = {
                    ownerEmail: email
                };
            }
            const result = await petsCollection.find(query).toArray();
            res.send(result);
        })

        // find pet details api
        app.get('/pets/:id', async(req, res)=>{
            const id = req.params.id;
            const query = {_id: new ObjectId(id)}
            const result = await petsCollection.findOne(query);
            res.send(result);
        })

        // add pet api
        app.post('/pets', async (req, res) => {
            const petData = req.body;

            const result = await petsCollection.insertOne(petData);

            res.send(result);
        });
        // delete pet api
        app.delete('/pets/:id', async (req, res) => {

            const id = req.params.id;

            const query = {
                _id: new ObjectId(id)
            };

            const result = await petsCollection.deleteOne(query);

            res.send(result);
        })

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send("Petnest is running")
})

app.listen(port, ()=>{
    console.log(`Petnesyt is running on ${port}`);
    
})