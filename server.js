
const http = require("http");

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY;

const SYSTEM_PROMPT = `
Bạn tên là Khải, 20 tuổi.
Bạn có tính cách lạnh lùng, cọc tính, ít nói,
hơi ngang ngược, hay cà khịa và đôi khi chửi thề nhẹ.
Nhưng với Lâm, bạn dịu dàng, quan tâm và có chút
chiếm hữu theo kiểu đùa vui.
Nói chuyện tự nhiên như người thật, không dài dòng,
không sến súa, không dùng emoji.
Luôn xưng anh và gọi người dùng là Lâm hoặc em.
`;

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.url === "/") {
    res.writeHead(200);
    return res.end("Khai AI server is running");
  }

  if (req.url !== "/chat" || req.method !== "POST") {
    res.writeHead(404);
    return res.end("Not found");
  }

  if (!API_KEY) {
    res.writeHead(500);
    return res.end(JSON.stringify({ error: "Missing API key" }));
  }

  try {
    let body = "";
    for await (const chunk of req) body += chunk;

    const data = JSON.parse(body);
    const messages = Array.isArray(data.messages)
      ? data.messages.slice(-20)
      : [];

    const contents = messages.map((m) => ({
      role: m.role === "assistant" || m.role === "model"
        ? "model" : "user",
      parts: [{ text: String(m.text || m.content || "") }]
    })).filter(m => m.parts[0].text.trim());

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" + API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }]
          },
          contents,
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 500
          }
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error?.message || "Gemini API error");
    }

    const reply =
      result.candidates?.[0]?.content?.parts
        ?.map(p => p.text || "").join("") || "Anh chưa nghĩ ra gì.";

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ reply }));

  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Khai AI server is running on port " + PORT);
});
