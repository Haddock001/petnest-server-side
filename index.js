import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import Stripe from "stripe";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ================= MIDDLEWARE =================
app.use(cors({
    origin: "http://localhost:5173",
    credentials: true
}));

app.use(express.json());
app.use(cookieParser());

const cookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
};

// ================= JWT VERIFY =================
const verifyToken = (req, res, next) => {
    const token = req.cookies?.token;

    if (!token) {
        return res.status(401).send({ message: "No token provided" });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(401).send({ message: "Invalid token" });
        }

        req.user = decoded;
        next();
    });
};

const verifyEmailOwner = (req, res, next) => {
    const email = req.query.email;

    if (!email) {
        return res.status(400).send({ message: "Email query is required" });
    }

    if (normalizeEmail(req.user?.email) !== normalizeEmail(email)) {
        return res.status(403).send({ message: "Forbidden access" });
    }

    next();
};

const getObjectId = (id, res) => {
    if (!ObjectId.isValid(id)) {
        res.status(400).send({ message: "Invalid id" });
        return null;
    }

    return new ObjectId(id);
};

const normalizeEmail = (email = "") => email.trim().toLowerCase();

const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);

const isBootstrapAdmin = (email) => adminEmails.includes(normalizeEmail(email));

const getCampaignState = (campaign) => {
    const donated = Number(campaign.donatedAmount) || 0;
    const max = Number(campaign.maxDonationAmount) || 0;

    if (max > 0 && donated >= max) {
        return "Milestone Reached";
    }

    if (campaign.lastDate) {
        const endDate = new Date(`${campaign.lastDate}T23:59:59.999Z`);

        if (!Number.isNaN(endDate.getTime()) && endDate < new Date()) {
            return "Ended";
        }
    }

    if (campaign.status === "Paused") {
        return "Paused";
    }

    return "Active";
};

const decorateCampaign = (campaign) => {
    if (!campaign) return null;

    const computedStatus = getCampaignState(campaign);

    return {
        ...campaign,
        status: computedStatus,
        computedStatus,
    };
};

// ================= MONGO =================
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@proli.vjehpyn.mongodb.net/?appName=ProLi`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

async function run() {
    await client.connect();

    const db = client.db("petnest");

    const petsCollection = db.collection("pets");
    const donationCollection = db.collection("donations");
    const donationPayments = db.collection("donationsPayments");
    const adoptionRequestsCollection = db.collection("adoptionRequests");
    const usersCollection = db.collection("users");

    const upsertUser = async ({ email, name, photoURL }) => {
        const normalizedEmail = normalizeEmail(email);
        const existingUser = await usersCollection.findOne({ email: normalizedEmail });
        const role = isBootstrapAdmin(normalizedEmail) || existingUser?.role === "admin"
            ? "admin"
            : "user";

        await usersCollection.updateOne(
            { email: normalizedEmail },
            {
                $set: {
                    email: normalizedEmail,
                    name: name || existingUser?.name || normalizedEmail.split("@")[0],
                    photoURL: photoURL || existingUser?.photoURL || "",
                    role,
                    updatedAt: new Date(),
                },
                $setOnInsert: {
                    createdAt: new Date(),
                },
            },
            { upsert: true }
        );

        return usersCollection.findOne({ email: normalizedEmail });
    };

    const getRequester = async (email) => {
        const normalizedEmail = normalizeEmail(email);
        const user = await usersCollection.findOne({ email: normalizedEmail });

        if (user) return user;

        return upsertUser({ email: normalizedEmail });
    };

    const requesterIsAdmin = async (email) => {
        const user = await getRequester(email);
        return user?.role === "admin";
    };

    const verifyAdmin = async (req, res, next) => {
        try {
            const isAdmin = await requesterIsAdmin(req.user?.email);

            if (!isAdmin) {
                return res.status(403).send({ message: "Admin access required" });
            }

            next();
        } catch (error) {
            res.status(500).send({ message: "Could not verify admin access" });
        }
    };

    // ================= HOME =================
    app.get("/", (req, res) => {
        res.send("Petnest server running");
    });

    // ================= JWT =================
    app.post("/jwt", async (req, res) => {
        const user = req.body;

        if (!user?.email) {
            return res.status(400).send({ message: "Email is required" });
        }

        const savedUser = await upsertUser({
            email: user.email,
            name: user.name,
            photoURL: user.photoURL,
        });

        const token = jwt.sign(
            { email: savedUser.email },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res
            .cookie("token", token, cookieOptions)
            .send({
                success: true,
                user: savedUser,
            });
    });

    app.post("/logout", (req, res) => {
        res
            .clearCookie("token", {
                httpOnly: true,
                sameSite: "lax",
                secure: process.env.NODE_ENV === "production",
            })
            .send({ success: true });
    });

    // ================= USERS / ROLES =================
    app.get("/users/me", verifyToken, async (req, res) => {
        const user = await getRequester(req.user.email);
        res.send(user);
    });

    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
        const result = await usersCollection
            .find()
            .sort({ role: 1, createdAt: -1 })
            .toArray();
        res.send(result);
    });

    app.patch("/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
        const id = getObjectId(req.params.id, res);
        if (!id) return;

        const role = req.body.role === "admin" ? "admin" : "user";
        const result = await usersCollection.updateOne(
            { _id: id },
            { $set: { role, updatedAt: new Date() } }
        );

        res.send(result);
    });

    // ================= PETS =================
    app.get("/pets", async (req, res) => {
        const includeAdopted = req.query.includeAdopted === "true";
        const query = includeAdopted ? {} : { adopted: { $ne: true } };
        const result = await petsCollection
            .find(query)
            .sort({ createdAt: -1 })
            .toArray();
        res.send(result);
    });

    app.get("/pets/:id", async (req, res) => {
        const id = getObjectId(req.params.id, res);
        if (!id) return;

        const result = await petsCollection.findOne({ _id: id });

        if (!result) {
            return res.status(404).send({ message: "Pet not found" });
        }

        res.send(result);
    });

    app.get("/my-pets", verifyToken, verifyEmailOwner, async (req, res) => {
        const result = await petsCollection
            .find({ ownerEmail: req.query.email })
            .sort({ createdAt: -1 })
            .toArray();
        res.send(result);
    });

    app.post("/pets", verifyToken, async (req, res) => {
        const pet = {
            ...req.body,
            ownerEmail: req.user.email,
            adopted: Boolean(req.body.adopted),
            createdAt: req.body.createdAt ? new Date(req.body.createdAt) : new Date(),
        };

        const result = await petsCollection.insertOne(pet);
        res.send(result);
    });

    app.patch("/pets/:id", verifyToken, async (req, res) => {
        const id = getObjectId(req.params.id, res);
        if (!id) return;

        const pet = await petsCollection.findOne({ _id: id });

        if (!pet) {
            return res.status(404).send({ message: "Pet not found" });
        }

        if (pet.ownerEmail !== req.user.email && !(await requesterIsAdmin(req.user.email))) {
            return res.status(403).send({ message: "Forbidden access" });
        }

        const result = await petsCollection.updateOne(
            { _id: id },
            { $set: req.body }
        );

        res.send(result);
    });

    app.delete("/pets/:id", verifyToken, async (req, res) => {
        const id = getObjectId(req.params.id, res);
        if (!id) return;

        const pet = await petsCollection.findOne({ _id: id });

        if (!pet) {
            return res.status(404).send({ message: "Pet not found" });
        }

        if (pet.ownerEmail !== req.user.email && !(await requesterIsAdmin(req.user.email))) {
            return res.status(403).send({ message: "Forbidden access" });
        }

        const result = await petsCollection.deleteOne({ _id: id });
        res.send(result);
    });

    // ================= DONATIONS =================
    app.get("/donations", async (req, res) => {
        const result = await donationCollection
            .find()
            .sort({ createdAt: -1 })
            .toArray();
        res.send(result.map(decorateCampaign));
    });

    app.get("/donations/:id", async (req, res) => {
        const id = getObjectId(req.params.id, res);
        if (!id) return;

        const result = await donationCollection.findOne({ _id: id });

        if (!result) {
            return res.status(404).send({ message: "Donation campaign not found" });
        }

        res.send(decorateCampaign(result));
    });

    app.get("/my-donations", verifyToken, verifyEmailOwner, async (req, res) => {
        const result = await donationCollection
            .find({ createdByEmail: req.query.email })
            .sort({ createdAt: -1 })
            .toArray();
        res.send(result.map(decorateCampaign));
    });

    app.post("/donations", verifyToken, async (req, res) => {
        const result = await donationCollection.insertOne({
            ...req.body,
            createdByEmail: req.user.email,
            donatedAmount: 0,
            status: "Active",
            createdAt: new Date(),
        });

        res.send(result);
    });

    app.patch("/donations/:id", verifyToken, async (req, res) => {
        const id = getObjectId(req.params.id, res);
        if (!id) return;

        const campaign = await donationCollection.findOne({ _id: id });

        if (!campaign) {
            return res.status(404).send({ message: "Donation campaign not found" });
        }

        if (campaign.createdByEmail !== req.user.email && !(await requesterIsAdmin(req.user.email))) {
            return res.status(403).send({ message: "Forbidden access" });
        }

        const allowedFields = {};
        ["petName", "petImage", "maxDonationAmount", "lastDate", "shortDescription", "longDescription", "status"].forEach((field) => {
            if (req.body[field] !== undefined) {
                allowedFields[field] = req.body[field];
            }
        });

        const result = await donationCollection.updateOne(
            { _id: id },
            { $set: allowedFields }
        );

        res.send(result);
    });

    // ================= ADOPTION REQUESTS =================
    app.post("/adoption-requests", verifyToken, async (req, res) => {
        const petId = getObjectId(req.body.petId, res);
        if (!petId) return;

        const pet = await petsCollection.findOne({ _id: petId });

        if (!pet) {
            return res.status(404).send({ message: "Pet not found" });
        }

        if (pet.adopted) {
            return res.status(400).send({ message: "This pet has already been adopted" });
        }

        if (normalizeEmail(pet.ownerEmail) === normalizeEmail(req.user.email)) {
            return res.status(400).send({ message: "You cannot request your own pet" });
        }

        const duplicateRequest = await adoptionRequestsCollection.findOne({
            petId: req.body.petId,
            adopterEmail: req.user.email,
            status: { $in: ["Pending", "Accepted"] },
        });

        if (duplicateRequest) {
            return res.status(400).send({ message: "You already requested this pet" });
        }

        const request = {
            ...req.body,
            petId: req.body.petId,
            petName: pet.name,
            petImage: pet.image,
            ownerEmail: pet.ownerEmail,
            adopterEmail: req.user.email,
            status: "Pending",
            createdAt: new Date(),
        };

        const result = await adoptionRequestsCollection.insertOne(request);
        res.send(result);
    });

    app.get("/adoption-requests", verifyToken, verifyEmailOwner, async (req, res) => {
        const result = await adoptionRequestsCollection
            .find({ ownerEmail: req.query.email })
            .toArray();
        res.send(result);
    });

    app.patch("/adoption-requests/:id", verifyToken, async (req, res) => {
        const id = getObjectId(req.params.id, res);
        if (!id) return;

        const request = await adoptionRequestsCollection.findOne({ _id: id });

        if (!request) {
            return res.status(404).send({ message: "Adoption request not found" });
        }

        if (request.ownerEmail !== req.user.email) {
            return res.status(403).send({ message: "Forbidden access" });
        }

        const status = req.body.status === "Accepted" ? "Accepted" : "Rejected";

        if (status === "Accepted" && request.petId && ObjectId.isValid(request.petId)) {
            await petsCollection.updateOne(
                { _id: new ObjectId(request.petId), ownerEmail: req.user.email },
                { $set: { adopted: true } }
            );

            await adoptionRequestsCollection.updateMany(
                {
                    petId: request.petId,
                    _id: { $ne: id },
                    status: "Pending",
                },
                { $set: { status: "Rejected" } }
            );
        }

        const result = await adoptionRequestsCollection.updateOne(
            { _id: id },
            { $set: { status } }
        );

        res.send(result);
    });

    // ================= STRIPE =================
    app.post("/create-payment-intent", verifyToken, async (req, res) => {
        const { amount, campaignId } = req.body;
        const id = getObjectId(campaignId, res);
        if (!id) return;

        const campaign = await donationCollection.findOne({ _id: id });

        if (!campaign) {
            return res.status(404).send({ message: "Donation campaign not found" });
        }

        const campaignState = getCampaignState(campaign);

        if (campaignState !== "Active") {
            return res.status(400).send({ message: `Campaign is ${campaignState}` });
        }

        const donationAmount = Number(amount);
        const donated = Number(campaign.donatedAmount) || 0;
        const max = Number(campaign.maxDonationAmount) || 0;

        if (!Number.isFinite(donationAmount) || donationAmount <= 0) {
            return res.status(400).send({ message: "Invalid donation amount" });
        }

        if (max > 0 && donated + donationAmount > max) {
            return res.status(400).send({
                message: `Only ${Math.max(max - donated, 0)} BDT remains for this campaign`,
            });
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(donationAmount * 100),
            currency: "usd",
            payment_method_types: ["card"],
            metadata: {
                campaignId: campaignId,
                donorEmail: req.user.email,
            },
        });

        res.send({ clientSecret: paymentIntent.client_secret });
    });

    // ================= DONATION PAYMENT =================
    app.post("/donations-payment", verifyToken, async (req, res) => {
        const id = getObjectId(req.body.campaignId, res);
        if (!id) return;

        const campaign = await donationCollection.findOne({ _id: id });

        if (!campaign) {
            return res.status(404).send({ message: "Donation campaign not found" });
        }

        const campaignState = getCampaignState(campaign);

        if (campaignState !== "Active") {
            return res.status(400).send({ message: `Campaign is ${campaignState}` });
        }

        const amount = Number(req.body.amount);
        const donated = Number(campaign.donatedAmount) || 0;
        const max = Number(campaign.maxDonationAmount) || 0;

        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).send({ message: "Invalid donation amount" });
        }

        if (max > 0 && donated + amount > max) {
            return res.status(400).send({
                message: `Only ${Math.max(max - donated, 0)} BDT remains for this campaign`,
            });
        }

        await donationCollection.updateOne(
            { _id: id },
            { $inc: { donatedAmount: amount } }
        );

        const result = await donationPayments.insertOne({
            ...req.body,
            amount,
            campaignOwnerEmail: campaign.createdByEmail,
            campaignPetName: campaign.petName,
            campaignPetImage: campaign.petImage,
            donorEmail: req.user.email,
            createdAt: new Date(),
        });

        res.send(result);
    });

    app.get("/campaign-donators", verifyToken, verifyEmailOwner, async (req, res) => {
        const result = await donationPayments
            .find({ campaignOwnerEmail: req.query.email })
            .toArray();
        res.send(result);
    });

    app.get("/my-donation-payments", verifyToken, verifyEmailOwner, async (req, res) => {
        const result = await donationPayments
            .find({ donorEmail: req.query.email })
            .sort({ createdAt: -1 })
            .toArray();
        res.send(result);
    });

    // ================= ADMIN =================
    app.get("/all-pets", verifyToken, verifyAdmin, async (req, res) => {
        const result = await petsCollection
            .find()
            .sort({ createdAt: -1 })
            .toArray();
        res.send(result);
    });

    app.get("/all-donations", verifyToken, verifyAdmin, async (req, res) => {
        const result = await donationCollection
            .find()
            .sort({ createdAt: -1 })
            .toArray();
        res.send(result.map(decorateCampaign));
    });

    app.delete("/donations/:id", verifyToken, verifyAdmin, async (req, res) => {
        const id = getObjectId(req.params.id, res);
        if (!id) return;

        const result = await donationCollection.deleteOne({ _id: id });
        res.send(result);
    });

    console.log("MongoDB connected");
}

run().catch(console.dir);

app.listen(port, () => {
    console.log(`Server running on ${port}`);
});
