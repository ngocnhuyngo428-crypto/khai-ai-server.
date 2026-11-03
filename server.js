
const http = require("http");

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY;

const MODEL = "gemini-3.6-flash";
const MAX_HISTORY = 10;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_OUTPUT_TOKENS = 800;

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

const lastRequests = new Map();

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Gửi yêu cầu và tự thử lại khi Gemini quá tải
async function callGemini(payload) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000)
      }
    );

    const raw = await response.text();

    let result;

    try {
      result = JSON.parse(raw);
    } catch {
      result = {};
    }

    if (response.ok) {
      return { response, result };
    }

    const retryable = [502, 503, 504].includes(response.status);

    if (retryable && attempt < maxAttempts) {
      console.log(
        `Gemini lỗi ${response.status}. Thử lại lần ${attempt + 1}/${maxAttempts}...`
      );

      await sleep(attempt * 1000);
      continue;
    }

    return { response, result };
  }
}

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
    return send(res, 404, {
      error: "Not found"
    });
  }

  if (!API_KEY) {
    console.error("Missing GEMINI_API_KEY");

    return send(res, 500, {
      error: "Server chưa được cấu hình API key."
    });
  }

  const ip = req.socket.remoteAddress || "unknown";

  try {
    let body = "";

    for await (const chunk of req) {
      body += chunk;

      if (body.length > 65536) {
        return send(res, 413, {
          error: "Tin nhắn gửi lên quá dài."
        });
      }
    }

    const data = JSON.parse(body);

    if (!Array.isArray(data.messages)) {
      return send(res, 400, {
        error: "Dữ liệu tin nhắn không hợp lệ."
      });
    }

    // Chống gửi yêu cầu quá nhanh
    const now = Date.now();
    const last = lastRequests.get(ip) || 0;

    if (now - last < 1500) {
      return send(res, 429, {
        error: "Từ từ thôi Lâm, anh đang trả lời mà."
      });
    }

    lastRequests.set(ip, now);

    // Giới hạn lịch sử trò chuyện
    let messages = data.messages
      .slice(-MAX_HISTORY)
      .map(m => ({
        role: m.role === "assistant" || m.role === "model"
          ? "model"
          : "user",
        text: String(m.text || m.content || "")
          .slice(0, MAX_MESSAGE_LENGTH)
          .trim()
      }))
      .filter(m => m.text);

    // Gemini cần bắt đầu bằng tin nhắn user
    while (messages.length && messages[0].role === "model") {
      messages.shift();
    }

    // Gộp tin nhắn liên tiếp cùng vai trò
    const contents = [];

    for (const m of messages) {
      const previous = contents[contents.length - 1];

      if (previous && previous.role === m.role) {
        previous.parts[0].text += "\n" + m.text;
      } else {
        contents.push({
          role: m.role,
          parts: [{ text: m.text }]
        });
      }
    }

    if (
      !contents.length ||
      contents[contents.length - 1].role !== "user"
    ) {
      return send(res, 400, {
        error: "Không tìm thấy tin nhắn mới của Lâm."
      });
    }

    const { response, result } = await callGemini({
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      contents,
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: MAX_OUTPUT_TOKENS
      }
    });

    if (!response.ok) {
      const message =
        result.error?.message || "Gemini API error";

      console.error(
        "Gemini API error:",
        response.status,
        message
      );

      // Cho phép Lâm thử lại ngay nếu Gemini gặp lỗi
      lastRequests.delete(ip);

      if (response.status === 429) {
        return send(res, 429, {
          error: "Khải đang hết lượt sử dụng API. Lâm thử lại sau nhé."
        });
      }

      if (response.status === 503) {
        return send(res, 503, {
          error: "Gemini đang quá tải. Lâm đợi một chút rồi thử lại nhé."
        });
      }

      return send(res, 502, {
        error: "Gemini đang gặp sự cố. Lâm thử lại sau nhé."
      });
    }

    const reply = result.candidates?.[0]?.content?.parts
      ?.map(p => p.text || "")
      .join("")
      .trim() || "Anh chưa nghĩ ra gì.";

    return send(res, 200, { reply });

  } catch (error) {
    console.error("Chat error:", error.message);

    // Không khóa lượt gửi tiếp theo khi yêu cầu bị lỗi
    lastRequests.delete(ip);

    if (
      error.name === "TimeoutError" ||
      error.name === "AbortError"
    ) {
      return send(res, 504, {
        error: "Khải phản hồi hơi lâu. Lâm thử lại nhé."
      });
    }

    return send(res, 500, {
      error: "Máy chủ gặp sự cố, thử lại sau nhé."
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    "Khai AI server is running on port " + PORT
  );
});
