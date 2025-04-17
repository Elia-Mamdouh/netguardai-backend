/* ──────────────────────────────────────────────────
   Basic imports
─────────────────────────────────────────────────── */
const express    = require("express");
const axios      = require("axios");
const admin      = require("firebase-admin");
const cors       = require("cors");
require("dotenv").config();

const OpenAI     = require("openai");
const nodemailer = require("nodemailer");
const fs         = require("fs");
const path       = require("path");
const handlebars = require("handlebars");

/* ──────────────────────────────────────────────────
   Firebase Admin SDK  (ENV‑based, no JSON file)
─────────────────────────────────────────────────── */
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

/* ──────────────────────────────────────────────────
   Express / OpenAI setup
─────────────────────────────────────────────────── */
const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function extractCommands(text) {
  // Look for any triple-backtick code block, e.g. ```something```
  const blocks = text.match(/```[\s\S]*?```/g);
  if (!blocks) return "";

  // Remove the ``` fences
  return blocks
    .map(b => b.replace(/```/g, "").trim())
    .join("\n\n");
}

function extractSection(title, text = "") {
  const regex = new RegExp(`${title}:\\s*([\\s\\S]*?)(\\n\\n|$)`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : `No ${title.toLowerCase()} found.`;
}

// Make the /reports folder publicly accessible
app.use("/reports", express.static(path.join(__dirname, "reports")));

app.post("/generate-report", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "No userId provided." });

    const conversationRef = db.collection("conversations").doc(userId);
    const doc = await conversationRef.get();
    if (!doc.exists) return res.status(400).json({ error: "No conversation found." });

    const messages = doc.data().messages;

    const userRef = db.collection("user's data").doc(userId);
    const userDoc = await userRef.get();
    const userEmail = userDoc.data().email;
    const userName = userDoc.data().name;

    const interactions = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (
        msg.role === "user" &&
        !/^(hello|hi|hey)$/i.test(msg.content.trim())
      ) {
        const response = messages.slice(i + 1).find(m => m.role === "assistant");
        const isCommand = /```[\s\S]*?```/.test(response?.content || "");

        if (isCommand) {
          const openaiRes = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
              {
                role: "system",
                content: "You are a network security expert. Always respond with lines starting with 'Benefits:' and 'Recommendations:' for the following configuration."
              },              
              {
                role: "user",
                content: response.content
              }
            ],
            temperature: 0.7
          });

          const openaiText = openaiRes.choices[0].message.content;
          const benefits = extractSection("Benefits", openaiText);
          const recommendations = extractSection("Recommendations", openaiText);

          interactions.push({
            query: msg.content,
            commands: extractCommands(response?.content || ""),
            benefits,
            recommendations,
            fullReply: null
          });
        } else {
          interactions.push({
            query: msg.content,
            commands: "",
            benefits: "Not applicable.",
            recommendations: "Not applicable.",
            fullReply: response?.content || "No reply found."
          });
        }
      }
    }

    const setupCount = interactions.filter(i =>
      /setup|hostname|vlan|interface|ssh|ip/i.test(i.commands)
    ).length;
    const securityCount = interactions.filter(i =>
      /firewall|snmp|access-list|ddos|password|security|acl/i.test(i.commands)
    ).length;

    const templatePath = path.join(__dirname, "templates", "report-template.html");
    const templateHtml = fs.readFileSync(templatePath, "utf8");
    const template = handlebars.compile(templateHtml);

    const htmlContent = template({
      user: userName,
      email: userEmail,
      date: new Date().toLocaleString(),
      totalQuestions: messages.filter(m => m.role === "user").length,
      topFeatures: "SSH, VLAN, SNMP",
      setupCount,
      securityCount,
      interactions
    });

    const reportsDir = path.join(__dirname, "reports");
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);

    const htmlFileName = `NetGuardAI_Report_${userId}.html`;
    const htmlFilePath = path.join(reportsDir, htmlFileName);
    fs.writeFileSync(htmlFilePath, htmlContent, "utf8");

    const linkUrl = `https://netguardai-backend.onrender.com/reports/${htmlFileName}`;

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      }
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: userEmail,
      subject: 'Your NetGuardAI Interactive HTML Report',
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h2 style="color: #3b82f6;">NetGuardAI - Your Network Security Report</h2>
          <p>Hello ${userName},</p>
          <p>Your interactive NetGuardAI report is ready. You can view it at the link below:</p>
          <p><a href="${linkUrl}" target="_blank">View My NetGuardAI Report</a></p>
          <p>You can also Print → Save as PDF from your browser.</p>
          <p>Best Regards,<br>NetGuardAI Team</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({ success: true, message: "HTML report generated & link emailed!" });

  } catch (error) {
    console.error("Error in /generate-report:", error.message);
    res.status(500).json({ error: "Something went wrong." });
  }
});

// URL of the Python FAISS microservice
const FAISS_URL = "https://netguardai-faiss.onrender.com/query";

app.post("/signup", async (req, res) => {
    try {
      const { email, name, password } = req.body;
      
      console.log("Signup attempt:", req.body); // ✅ Log received data
  
      if (!email || !name || !password) {
        return res.status(400).json({ success: false, message: "Missing required fields" });
      }
  
      const userRef = db.collection("user's data").where("email", "==", email);
      const userSnapshot = await userRef.get();
  
      if (!userSnapshot.empty) {
        console.log("User already exists"); // ✅ Log duplicates
        return res.status(400).json({ success: false, message: "User already exists!" });
      }
  
      const userDoc = await db.collection("user's data").add({
        email,
        name,
        password,
        createdAt: new Date(),
    });

    console.log("User registered successfully:", email); 
    res.status(201).json({ success: true, message: "User registered successfully!", userId: userDoc.id });
  
    } catch (error) {
      console.error("Error saving user:", error.message); // ✅ Log Firestore errors
      res.status(500).json({ success: false, message: error.message });
    }
  });
  

// User Login API
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const userRef = db.collection("user's data").where("email", "==", email);
    const userSnapshot = await userRef.get();

    if (userSnapshot.empty) {
      return res.status(400).json({ success: false, message: "User not found!" });
    }

    let userId = null;
    let userData = null;
    userSnapshot.forEach((doc) => {
      userData = doc.data();
      userId = doc.id; // Get user ID
    });

    if (userData.password !== password) {
      return res.status(401).json({ success: false, message: "Incorrect password!" });
    }

    res.status(200).json({ success: true, message: "Login successful!", userId: userId });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// -------------------------------
//           CHATBOT
// -------------------------------
app.post("/chat", async (req, res) => {
  try {
    const { message, userId } = req.body; // Now receiving userId instead of sessionId
    if (!message) return res.status(400).json({ error: "No user message provided." });
    if (!userId) return res.status(400).json({ error: "No userId provided." });

    // Retrieve conversation from Firestore
    const conversationRef = db.collection("conversations").doc(userId); // Use userId instead of sessionId
    const doc = await conversationRef.get();
    let messages = doc.exists ? doc.data().messages : [];

    // Add the user's message to messages array
    messages.push({ role: "user", content: message });

    // Query the Python FAISS service
    const faissResponse = await axios.post(FAISS_URL, { query: message });
    const relevantDocs = faissResponse.data.results;

    if (!relevantDocs.length) {
      const defaultReply = "I can provide setup and security configurations for Cisco, Juniper, Palo Alto, Fortinet, and F5.";
      messages.push({ role: "assistant", content: defaultReply });
      await conversationRef.set({ messages }); // Save messages under userId
      return res.json({ reply: defaultReply });
    }

    const systemPrompt = `
You are a network assistant providing guidance for setting up and securing network devices.
The following documents are relevant:
${relevantDocs.join("\n\n")}
Please ask the user if they want to proceed to see the exact commands when necessary.
    `;

    const MAX_MESSAGES = 5;
    const recentMessages = messages.slice(-MAX_MESSAGES);

    const oldMessages = messages.slice(0, -MAX_MESSAGES);
    let summaryText = "";

    if (oldMessages.length > 0) {
      summaryText = oldMessages.map(m => `${m.role}: ${m.content}`).join(" ");
      
      if (summaryText.length > 1000) {
        try {
          const summaryResponse = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "system", content: `Summarize the following conversation:\n\n${summaryText}` }],
            temperature: 0.7,
          });

          summaryText = summaryResponse.choices[0].message.content;
        } catch (error) {
          console.log("Failed to summarize old messages. Proceeding with raw text.");
        }
      }

      if (summaryText.length > 500) {
        summaryText = summaryText.slice(0, 500) + "...(truncated)";
      }
    }

    const chatMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Previous conversation summary: ${summaryText}` },
      ...recentMessages
    ];

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: chatMessages,
        temperature: 0.7,
      });

      const finalAnswer = completion.choices[0].message.content;

      // Save assistant's response to messages array
      messages.push({ role: "assistant", content: finalAnswer });
      await conversationRef.set({ messages }); // Save messages under userId

      return res.json({ reply: finalAnswer });

    } catch (error) {
      if (error.message.includes("tokens per min")) {
        console.log("Token limit reached. Creating a new conversation.");

        // Save the old conversation under a new document ID
        const newUserId = `${userId}-${Date.now()}`;
        await db.collection("conversations").doc(newUserId).set({ messages });

        // Start a fresh conversation for the original userId
        messages = [{ role: "user", content: message }];
        await conversationRef.set({ messages });

        return res.json({ reply: "Token limit reached. Starting a new conversation. Please continue." });
      } else {
        console.error("Error in /chat:", error.message);
        return res.status(500).json({ error: "Something went wrong." });
      }
    }
  } catch (error) {
    console.error("Error in /chat:", error.message);
    return res.status(500).json({ error: "Something went wrong." });
  }
});

// Retrieve previous messages for a user
app.post("/get-messages", async (req, res) => {
  try {
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ error: "No userId provided." });

      const conversationRef = db.collection("conversations").doc(userId);
      const doc = await conversationRef.get();

      if (!doc.exists) {
          return res.json({ success: false, message: "No previous messages found." });
      }

      const messages = doc.data().messages;
      return res.json({ success: true, messages });
  } catch (error) {
      console.error("Error fetching messages:", error.message);
      return res.status(500).json({ error: "Failed to fetch previous messages." });
  }
});

// Clear conversation API
app.post("/clear-conversation", async (req, res) => {
  try {
      const { userId } = req.body;

      if (!userId) return res.status(400).json({ error: "No userId provided." });

      // Clear the conversation for the user
      const conversationRef = db.collection("conversations").doc(userId);
      await conversationRef.set({ messages: [] });  // Reset messages to an empty array

      return res.json({ success: true, message: "Conversation cleared successfully." });
  } catch (error) {
      console.error("Error clearing conversation:", error.message);
      return res.status(500).json({ error: "Failed to clear conversation." });
  }
});

app.get("/", (req, res) => {
  res.send("🎉 Backend is live and working!");
});
// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
