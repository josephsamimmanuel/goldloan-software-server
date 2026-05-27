const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const dotenv = require("dotenv");
dotenv.config();

const { initializeApp } = require("firebase/app");
const {
  getFirestore,
  doc,
  getDoc,
  updateDoc,
  arrayUnion,
  query,
  collection,
  where,
  getDocs,
} = require("firebase/firestore");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");

const firebaseConfig = {
  apiKey: "AIzaSyAMqtmbUUYpRTklqZldXBFryjTOEEdBywg",
  authDomain: "goldloan-software.firebaseapp.com",
  projectId: "goldloan-software",
  storageBucket: "goldloan-software.firebasestorage.app",
  messagingSenderId: "1001667673899",
  appId: "1:1001667673899:web:2c0ebe79a06ccb5e098f6e",
  measurementId: "G-5L4YNNHPDG",
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

let firebaseAuthReady = Promise.resolve(false);

if (process.env.FIREBASE_AUTH_EMAIL && process.env.FIREBASE_AUTH_PASSWORD) {
  firebaseAuthReady = signInWithEmailAndPassword(
    auth,
    process.env.FIREBASE_AUTH_EMAIL,
    process.env.FIREBASE_AUTH_PASSWORD
  )
    .then((userCredential) => {
      console.log(
        `Backend successfully authenticated with Firebase Auth as: ${userCredential.user.email}`
      );
      return true;
    })
    .catch((err) => {
      console.error("Backend Firebase Auth authentication failed:", err.message);
      return false;
    });
} else {
  console.warn(
    "FIREBASE_AUTH_EMAIL and FIREBASE_AUTH_PASSWORD not set. Webhook Firestore updates will fail."
  );
}

async function ensureFirebaseAuth() {
  const ready = await firebaseAuthReady;
  if (!ready) {
    throw new Error("Firebase authentication is not configured or failed");
  }
  if (!auth.currentUser) {
    await signInWithEmailAndPassword(
      auth,
      process.env.FIREBASE_AUTH_EMAIL,
      process.env.FIREBASE_AUTH_PASSWORD
    );
  }
}

function verifyRazorpaySignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("RAZORPAY_WEBHOOK_SECRET is not set");
  }
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return signature === expectedSignature;
}

function parseNotes(notes) {
  if (!notes || typeof notes !== "object") return {};
  return {
    dbId: notes.dbId ? String(notes.dbId) : "",
    loanId: notes.loanId ? String(notes.loanId) : "",
    closeRemarks: notes.closeRemarks ? String(notes.closeRemarks) : "",
  };
}

function getPaidAmountRupees(paymentLinkEntity, paymentEntity) {
  if (paymentLinkEntity?.amount_paid != null) {
    return Number(paymentLinkEntity.amount_paid) / 100;
  }
  if (paymentEntity?.amount != null) {
    return Number(paymentEntity.amount) / 100;
  }
  return 0;
}

function getRazorpayPaymentId(paymentLinkEntity, paymentEntity) {
  if (paymentEntity?.id) return paymentEntity.id;
  const fromLink = paymentLinkEntity?.payments;
  if (Array.isArray(fromLink) && fromLink.length > 0) {
    return fromLink[0].payment_id || fromLink[0].id || null;
  }
  return null;
}

async function findBillingDocument(dbId, loanId) {
  if (dbId) {
    const directRef = doc(db, "billing", dbId);
    const directSnap = await getDoc(directRef);
    if (directSnap.exists()) {
      return { docRef: directRef, docSnap: directSnap };
    }
  }

  if (loanId) {
    const byLoanIdRef = doc(db, "billing", loanId);
    const byLoanIdSnap = await getDoc(byLoanIdRef);
    if (byLoanIdSnap.exists()) {
      return { docRef: byLoanIdRef, docSnap: byLoanIdSnap };
    }

    const billingRef = collection(db, "billing");
    const q = query(billingRef, where("customerId", "==", loanId));
    const querySnap = await getDocs(q);
    if (!querySnap.empty) {
      const match = querySnap.docs[0];
      return { docRef: doc(db, "billing", match.id), docSnap: match };
    }
  }

  return { docRef: null, docSnap: null };
}

function calculateOutstanding(loanData) {
  if (loanData.outstanding !== undefined && loanData.outstanding !== null) {
    return Number(loanData.outstanding);
  }
  const amount = Number(loanData.form?.loanAmount || 0);
  const interest = Number(loanData.form?.interest || 0);
  return amount + (amount * interest) / 100;
}

function paymentAlreadyRecorded(existingPayments, razorpayPaymentId) {
  if (!razorpayPaymentId || !Array.isArray(existingPayments)) return false;
  return existingPayments.some(
    (p) => p.razorpayPaymentId === razorpayPaymentId && p.status === "paid"
  );
}

async function applyPaymentToLoan({ dbId, loanId, closeRemarks, paidAmount, razorpayPaymentId, razorpayPaymentLinkId }) {
  await ensureFirebaseAuth();

  const { docRef, docSnap } = await findBillingDocument(dbId, loanId);
  if (!docRef || !docSnap?.exists()) {
    throw Object.assign(
      new Error(`Billing document not found (dbId=${dbId || "N/A"}, loanId=${loanId || "N/A"})`),
      { statusCode: 404 }
    );
  }

  const loanData = docSnap.data();
  const existingPayments = loanData.payments || [];

  if (paymentAlreadyRecorded(existingPayments, razorpayPaymentId)) {
    console.log(`Payment ${razorpayPaymentId} already recorded for ${docRef.id}, skipping`);
    return { docId: docRef.id, skipped: true };
  }

  const currentOutstanding = calculateOutstanding(loanData);
  const newOutstanding = Math.max(0, currentOutstanding - paidAmount);

  const paymentRecord = {
    amount: paidAmount,
    date: new Date().toISOString(),
    razorpayPaymentId: razorpayPaymentId || null,
    razorpayPaymentLinkId: razorpayPaymentLinkId || null,
    status: "paid",
    paidAt: new Date().toISOString(),
    isClosing: newOutstanding === 0,
    remarks: closeRemarks || "",
  };

  await updateDoc(docRef, {
    outstanding: newOutstanding,
    payments: arrayUnion(paymentRecord),
  });

  console.log(
    `Firestore updated: billing/${docRef.id}, paid ₹${paidAmount}, outstanding ₹${newOutstanding}`
  );

  return { docId: docRef.id, newOutstanding, skipped: false };
}

async function processPaymentLinkEntity(paymentLink, paymentEntity) {
  if (!paymentLink) {
    throw new Error("payment_link entity missing");
  }

  const { dbId, loanId, closeRemarks } = parseNotes(paymentLink.notes);
  const paidAmount = getPaidAmountRupees(paymentLink, paymentEntity);
  const razorpayPaymentId = getRazorpayPaymentId(paymentLink, paymentEntity);
  const razorpayPaymentLinkId = paymentLink.id;

  if (!dbId && !loanId) {
    throw Object.assign(new Error("payment_link notes missing dbId and loanId"), { statusCode: 400 });
  }
  if (paidAmount <= 0) {
    throw Object.assign(new Error("Invalid paid amount"), { statusCode: 400 });
  }

  return applyPaymentToLoan({
    dbId,
    loanId,
    closeRemarks,
    paidAmount,
    razorpayPaymentId,
    razorpayPaymentLinkId,
  });
}

async function handlePaymentLinkPaid(payload) {
  const paymentLink = payload?.payment_link?.entity;
  const payment = payload?.payment?.entity;

  if (!paymentLink) {
    throw new Error("payment_link.paid payload missing payment_link.entity");
  }

  return processPaymentLinkEntity(paymentLink, payment);
}

async function handlePaymentCaptured(payload) {
  const payment = payload?.payment?.entity;
  if (!payment) return null;

  const notes = parseNotes(payment.notes);
  if (!notes.dbId && !notes.loanId) return null;

  const paidAmount = Number(payment.amount) / 100;
  return applyPaymentToLoan({
    dbId: notes.dbId,
    loanId: notes.loanId,
    closeRemarks: notes.closeRemarks,
    paidAmount,
    razorpayPaymentId: payment.id,
    razorpayPaymentLinkId: null,
  });
}

const app = express();

const allowedOrigins = [process.env.FRONTEND_URL, "http://localhost:3000"].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, origin || allowedOrigins[0]);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

async function razorpayWebhookHandler(req, res) {
  const signature = req.headers["x-razorpay-signature"];
  const userAgent = req.headers["user-agent"] || "unknown";
  const rawBody = req.body;

  console.log(`Webhook POST from: ${userAgent}`);

  if (!signature) {
    console.error("Webhook: missing x-razorpay-signature header");
    return res.status(400).json({ success: false, message: "Signature missing" });
  }

  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    console.error("Webhook: empty raw body");
    return res.status(400).json({ success: false, message: "Empty body" });
  }

  try {
    if (!verifyRazorpaySignature(rawBody, signature)) {
      console.error("Webhook: signature verification failed (check RAZORPAY_WEBHOOK_SECRET matches Razorpay dashboard)");
      return res.status(400).json({ success: false, message: "Invalid signature" });
    }
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }

  let eventBody;
  try {
    eventBody = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    console.error("Webhook: invalid JSON body", err.message);
    return res.status(400).json({ success: false, message: "Invalid JSON" });
  }

  const { event, payload } = eventBody;
  console.log(`Webhook received: ${event}`);

  try {
    if (event === "payment_link.paid") {
      await handlePaymentLinkPaid(payload);
    } else if (event === "payment.captured") {
      await handlePaymentCaptured(payload);
    } else {
      console.log(`Webhook ignored (no handler): ${event}`);
    }
  } catch (err) {
    const status = err.statusCode || 500;
    console.error(`Webhook handler error [${event}]:`, err.message);
    return res.status(status).json({ success: false, message: err.message });
  }

  return res.status(200).json({ status: "ok" });
}

app.post(
  ["/razorpay-webhook", "/api/payment/webhook"],
  express.raw({ type: "*/*", limit: "2mb" }),
  razorpayWebhookHandler
);

app.use(express.json());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const MERCHANT_NAME = process.env.MERCHANT_NAME || "Maps Association";

function buildRazorpayPaymentLinkCallbackUrl(paymentLinkId) {
  const base = `https://razorpay.com/payment-link/${paymentLinkId}`;
  const isTestMode = (process.env.RAZORPAY_KEY_ID || "").startsWith("rzp_test_");
  return isTestMode ? `${base}/test` : base;
}

app.post("/api/payment/generate-link", async (req, res) => {
  const { amount, phone, customerName, loanId, dbId, closeRemarks } = req.body;

  if (!amount || !phone || !dbId) {
    return res.status(400).json({
      success: false,
      message: "amount, phone, and dbId are required",
    });
  }

  try {
    const paymentLink = await razorpay.paymentLink.create({
      amount: Number(amount) * 100,
      currency: "INR",
      accept_partial: false,
      description: `Gold Loan Payment for ID: ${loanId || dbId}`,
      customer: {
        name: customerName || "Customer",
        contact: phone.startsWith("+") ? phone : `+91${phone}`,
      },
      notify: {
        sms: true,
      },
      reminder_enable: true,
      options: {
        checkout: {
          name: MERCHANT_NAME,
        },
      },
      notes: {
        loanId: String(loanId || ""),
        dbId: String(dbId),
        closeRemarks: String(closeRemarks || ""),
      },
    });

    const callbackUrl = buildRazorpayPaymentLinkCallbackUrl(paymentLink.id);
    try {
      await razorpay.paymentLink.edit(paymentLink.id, {
        callback_url: callbackUrl,
        callback_method: "get",
      });
    } catch (editErr) {
      console.error("Failed to set payment link callback_url:", editErr.message);
    }

    res.status(200).json({
      success: true,
      short_url: paymentLink.short_url,
      id: paymentLink.id,
      callback_url: callbackUrl,
    });
  } catch (error) {
    console.error("Razorpay Link Error:", error);
    res.status(500).json({ success: false, message: "Link generation failed", error: error.message });
  }
});

// Fallback when Razorpay webhooks do not reach localhost (poll after customer pays)
app.post("/api/payment/sync-status", async (req, res) => {
  const { paymentLinkId } = req.body;

  if (!paymentLinkId) {
    return res.status(400).json({ success: false, message: "paymentLinkId is required" });
  }

  try {
    const paymentLink = await razorpay.paymentLink.fetch(paymentLinkId);
    const status = paymentLink.status;

    if (status !== "paid") {
      return res.status(200).json({ success: true, status, updated: false });
    }

    const result = await processPaymentLinkEntity(paymentLink, null);
    return res.status(200).json({
      success: true,
      status,
      updated: !result.skipped,
      newOutstanding: result.newOutstanding ?? null,
      docId: result.docId ?? null,
    });
  } catch (error) {
    console.error("Payment link sync error:", error.message);
    const status = error.statusCode || 500;
    return res.status(status).json({ success: false, message: error.message });
  }
});

app.get("/api/payment/diagnostics", async (req, res) => {
  try {
    await ensureFirebaseAuth();
    const currentUser = auth.currentUser;

    let firestoreConnected = false;
    let billingCount = 0;
    const dbStatus = [];
    try {
      const { limit } = require("firebase/firestore");
      const q = query(collection(db, "billing"), limit(1));
      const snap = await getDocs(q);
      firestoreConnected = true;
      billingCount = snap.size;
    } catch (dbErr) {
      dbStatus.push(`Firestore Error: ${dbErr.message}`);
    }

    res.status(200).json({
      success: true,
      firebase: {
        authenticated: !!currentUser,
        email: currentUser ? currentUser.email : null,
        uid: currentUser ? currentUser.uid : null,
      },
      firestore: {
        connected: firestoreConnected,
        hasBillingDocs: billingCount > 0,
        errors: dbStatus,
      },
      webhookSecretConfigured: !!process.env.RAZORPAY_WEBHOOK_SECRET,
      webhookSecretLength: process.env.RAZORPAY_WEBHOOK_SECRET
        ? process.env.RAZORPAY_WEBHOOK_SECRET.length
        : 0,
      webhookUrl: process.env.RAZORPAY_WEBHOOK_URL || null,
      razorpayMode: (process.env.RAZORPAY_KEY_ID || "").startsWith("rzp_test_") ? "test" : "live",
      port: PORT,
      webhookSetup:
        "Razorpay has separate webhooks for Test and Live. Your keys are test keys — configure the webhook in Test Mode (dashboard toggle) with the exact ngrok URL. After payment, check Settings → Webhooks → your webhook → Logs.",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = Number(process.env.PORT) || 5000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook endpoint: POST /api/payment/webhook`);
  if (process.env.RAZORPAY_WEBHOOK_URL) {
    console.log(`Configured webhook URL: ${process.env.RAZORPAY_WEBHOOK_URL}`);
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other process and restart.`);
  } else {
    console.error("Server error:", err.message);
  }
  process.exit(1);
});
