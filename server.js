const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const dotenv = require("dotenv");
dotenv.config();

const app = express();
// CORS configuration..
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Access-Control-Allow-Origin"],
}));
app.use(express.json());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});


app.post("/api/payment/generate-link", async (req, res) => {
  const { amount, phone, customerName, loanId } = req.body;

  try {
    
    const paymentLink = await razorpay.paymentLink.create({
      amount: Number(amount) * 100, 
      currency: "INR",
      accept_partial: false,
      description: `Gold Loan Payment for ID: ${loanId}`,
      customer: {
        name: customerName,
        contact: `+91${phone}`, 
      },
      notify: {
        sms: true,  
      },
      reminder_enable: true,
      notes: {
        loanId: loanId
      },
      callback_url: "https://yourwebsite.com/payment-success", 
      callback_method: "get"
    });

   
    res.status(200).json({ success: true, short_url: paymentLink.short_url });

  } catch (error) {
    console.error("Razorpay Link Error:", error);
    res.status(500).json({ success: false, message: "Link generation failed", error });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});