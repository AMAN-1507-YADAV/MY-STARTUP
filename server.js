import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import Groq from "groq-sdk";

const app = express();
const PORT = 3000;

app.use(express.json());

const getAIClient = () => {
  const apiKey = process.env.GROQ_API_KEY || "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";
  return new Groq({ apiKey });
};

// --- Wikipedia Helpler ---
async function fetchWikipediaContent(topic) {
  const wikiUrl = "https://en.wikipedia.org/w/api.php";
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    titles: topic,
    prop: "extracts|pageimages",
    explaintext: "true",
    pithumbsize: "800",
    origin: "*",
  });

  const response = await fetch(`${wikiUrl}?${params}`);
  if (!response.ok) {
    throw new Error(`Wikipedia API Error: ${response.status}`);
  }

  const data = await response.json();
  const pages = data.query?.pages;
  if (!pages) {
     throw new Error(`No Wikipedia page found for "${topic}".`);
  }
  const pageKey = Object.keys(pages)[0];
  const page = pages[pageKey];

  if (!page.extract) {
    throw new Error(`No Wikipedia page found for "${topic}". Try a different topic.`);
  }

  let wikiText = page.extract;
  // Limit to avoid excessively long prompts
  if (wikiText.length > 6000) {
    wikiText = wikiText.substring(0, 6000) + "...";
  }

  const mainImage = page.thumbnail?.source;
  let extraImages = [];

  try {
     const imgParams = new URLSearchParams({
       action: "query",
       format: "json",
       generator: "images",
       titles: topic,
       gimlimit: "15",
       prop: "imageinfo",
       iiprop: "url",
       origin: "*"
     });
     const imgRes = await fetch(`${wikiUrl}?${imgParams}`);
     const imgData = await imgRes.json();
     if (imgData.query?.pages) {
        Object.values(imgData.query.pages).forEach(p => {
           if (p.imageinfo && p.imageinfo[0] && p.imageinfo[0].url) {
              const url = p.imageinfo[0].url;
              // Ensure it's an authentic image type, omit common boring ones like flags or small icons if possible,
              // but mostly just filter extensions
              if (url.match(/\.(jpeg|jpg|png)$/i) && url !== mainImage && !url.includes("stub")) {
                 extraImages.push(url);
              }
           }
        });
     }
  } catch (e) {
     console.warn("Could not fetch extra images", e);
  }

  return { text: wikiText, mainImage, extraImages: extraImages.slice(0, 3) };
}

// --- AI Flashcard Generation Endpoint ---
  app.post("/api/generate", async (req, res) => {
  try {
    const { source, content, numCards, difficulty, format } = req.body;

    if (!content) {
      return res.status(400).json({ error: "Content (or topic) is required." });
    }

    let materialToDigest = content;

    // If the user requested to generate by topic, use the topic directly and optionally fetch an image
    let wikiImage = null;
    if (source === "topic") {
      try {
        const wikiData = await fetchWikipediaContent(content);
        wikiImage = wikiData.mainImage;
      } catch (err) {
        console.warn("Could not fetch Wikipedia image for topic:", content);
      }
      materialToDigest = `Please generate educational content from your extensive internal knowledge base about the topic: "${content}".`;
    }

    const ai = getAIClient();
    
    const isMCQ = format === 'mcq';
    const isLongAnswer = format === 'long_answer';
    
    const prompt = `Generate exactly ${numCards} study items from the provided topic or content. Note that the target audience is a student looking to learn effectively.

The items should reflect a ${difficulty} difficulty level.
Each item must contain:
1. A clear, concise question (1-2 sentences).
2. A complete, accurate answer explaining the concept.${isLongAnswer ? ' Ensure the answer is comprehensive, detailed, and explores the subject deeply (at least 3-4 paragraphs).' : ' Ensure the answer is relatively brief but informative.'}
${isMCQ ? '3. Four multiple-choice options (labeled A, B, C, D) with exactly ONE correct answer.\n' : ''}

You MUST return the output as a JSON object containing a "flashcards" array.
Each flashcard should have a "question" and "answer" string property.
${isMCQ ? 'Each flashcard must also have an "options" array of objects, where each option has "label" (string), "text" (string), and "correct" (boolean).\n' : ''}

Content/Topic to use:
${materialToDigest}`;

    let attempt = 0;
    const maxRetries = 2;
    let response;

    while (attempt <= maxRetries) {
      try {
        response = await ai.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: "You are a helpful educational assistant." },
            { role: "user", content: prompt }
          ],
          response_format: { type: "json_object" }
        });
        break;
      } catch (e) {
        const isUnavailable = e.status === 503 || e.message?.includes("503") || e.message?.includes("high demand") || e.message?.includes("UNAVAILABLE");
        const isRateLimited = e.status === 429 || e.message?.includes("429") || e.message?.includes("quota") || e.message?.includes("RESOURCE_EXHAUSTED");
        
        if ((isUnavailable || isRateLimited) && attempt < maxRetries) {
          const delay = isRateLimited ? 8000 : 1000 * (attempt + 1);
          console.warn(`Attempt ${attempt + 1} failed due to rate limits/high demand. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          attempt++;
        } else if (isUnavailable) {
          throw new Error("The AI service is currently experiencing high demand. Please wait a moment and try again.");
        } else if (isRateLimited) {
          throw new Error("The free quota is exceeded.");
        } else {
          throw e;
        }
      }
    }

    const outputText = response?.choices?.[0]?.message?.content;
    if (!outputText) {
       throw new Error("No response from AI model");
    }

    const parsedJson = JSON.parse(outputText);
    const flashcards = parsedJson.flashcards || parsedJson;
    res.json({ flashcards });
  } catch (error) {
    console.error("Error generating flashcards:", error);
    res.status(500).json({ error: error.message || "An unexpected error occurred." });
  }
});

// --- AI Topic Info Endpoint ---
app.post("/api/info", async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic) {
      return res.status(400).json({ error: "Topic is required." });
    }

    let wikiData = { text: "", mainImage: null };
    try {
      wikiData = await fetchWikipediaContent(topic);
    } catch (err) {
      console.warn("Could not fetch Wikipedia content for topic:", topic);
    }
    const ai = getAIClient();
    
    const prompt = `Provide a detailed, comprehensive, and essential overview of the following topic for a student: "${topic}".
    
You are a highly capable AI assistant. Please use your own extensive internal knowledge base to explain the topic deeply and clearly.

Structure the response elegantly with paragraphs and bullet points if appropriate. Focus purely on educational value.

Crucial Visual Instruction: ONLY use the authentic Wikipedia images provided below. DO NOT generate ANY other image links and DO NOT invent any images. YOU MUST USE STANDARD MARKDOWN IMAGE SYNTAX so they render correctly on the screen.

${wikiData.mainImage ? `At the very beginning of your response, output exactly this markdown:
![Main image of ${topic}](${wikiData.mainImage})` : ''}

${wikiData.extraImages && wikiData.extraImages.length > 0 ? `Embed these additional authentic images within the relevant subtopics where they fit best. You must use these exact markdown tags (do not invent your own):
${wikiData.extraImages.map((url, i) => `![Related authentic image ${i+1}](${url})`).join('\n')}` : ''}

Important: Do not provide the image URLs as plain text or "source links". Just output the exact markdown tags provided above so the image directly displays in the lesson.`;

    let attempt = 0;
    const maxRetries = 2;
    let response;

    while (attempt <= maxRetries) {
      try {
        response = await ai.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: "You are a helpful educational assistant." },
            { role: "user", content: prompt }
          ]
        });
        break;
      } catch (e) {
        const isUnavailable = e.status === 503 || e.message?.includes("503") || e.message?.includes("high demand") || e.message?.includes("UNAVAILABLE");
        const isRateLimited = e.status === 429 || e.message?.includes("429") || e.message?.includes("quota") || e.message?.includes("RESOURCE_EXHAUSTED");
        
        if ((isUnavailable || isRateLimited) && attempt < maxRetries) {
          const delay = isRateLimited ? 8000 : 1000 * (attempt + 1);
          console.warn(`Attempt ${attempt + 1} failed due to rate limits/high demand. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          attempt++;
        } else if (isUnavailable) {
          throw new Error("The AI service is currently experiencing high demand. Please wait a moment and try again.");
        } else if (isRateLimited) {
          throw new Error("The free quota is exceeded.");
        } else {
          throw e;
        }
      }
    }

    const outputText = response?.choices?.[0]?.message?.content;
    if (!outputText) {
       throw new Error("No response from AI model");
    }

    res.json({ info: outputText });
  } catch (error) {
    console.error("Error generating info:", error);
    res.status(500).json({ error: error.message || "An unexpected error occurred." });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Vite builds to 'dist'
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
