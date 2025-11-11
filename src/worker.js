import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis/cloudflare";

// Security config
const SECURITY_CONFIG = {
  MAX_PROMPT_LENGTH: 500,
  MIN_PROMPT_LENGTH: 3,
  MAX_REQUEST_SIZE: 10000, // 10KB
  DAILY_SPENDING_CAP: 10.00, // $10 USD
  GLOBAL_RATE_LIMIT: 100, // requests per hour across all users
  BLOCKED_WORDS: [
    "nude", "nsfw", "naked", "porn", "xxx", "sex", "explicit",
    "gore", "violence", "kill", "death", "suicide", "weapon"
  ]
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ========================================
    // POST /api/generate → Generate and store image
    // ========================================
    if (request.method === "POST" && url.pathname === "/api/generate") {
      // 0) Request size validation
      const contentLength = request.headers.get("content-length");
      if (contentLength && parseInt(contentLength) > SECURITY_CONFIG.MAX_REQUEST_SIZE) {
        return new Response(JSON.stringify({ 
          error: "request_too_large",
          message: "Request body exceeds 10KB limit"
        }), {
          status: 413,
          headers: { "content-type": "application/json" }
        });
      }

      // 1) Authentication check
      // Allow requests from our own frontend (same origin) OR with valid API key
      const origin = request.headers.get("origin");
      const referer = request.headers.get("referer");
      const apiKey = request.headers.get("x-api-key");

      const isSameOrigin = origin?.includes(url.host) || referer?.includes(url.host);

      if (!isSameOrigin && (!apiKey || apiKey !== env.DEMO_API_KEY)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }

      // 2) Rate limiting (if Upstash configured)
      if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        const redis = Redis.fromEnv(env);
        
        // Per-IP rate limit (10 requests/minute)
        const ipLimiter = new Ratelimit({
          redis,
          limiter: Ratelimit.fixedWindow(10, "1 m"),
          prefix: "rl:ip"
        });
        
        const { success: ipSuccess, remaining, reset } = await ipLimiter.limit(ip);
        if (!ipSuccess) {
          return new Response(JSON.stringify({ 
            error: "rate_limit_exceeded",
            message: "Too many requests from your IP. Try again in 1 minute."
          }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-remaining": String(remaining),
              "x-ratelimit-reset": String(reset)
            }
          });
        }

        // Global rate limit (100 requests/hour across all users)
        const globalLimiter = new Ratelimit({
          redis,
          limiter: Ratelimit.fixedWindow(SECURITY_CONFIG.GLOBAL_RATE_LIMIT, "1 h"),
          prefix: "rl:global"
        });
        
        const { success: globalSuccess } = await globalLimiter.limit("all");
        if (!globalSuccess) {
          return new Response(JSON.stringify({ 
            error: "global_rate_limit_exceeded",
            message: "System is currently at capacity. Please try again later."
          }), {
            status: 429,
            headers: { "content-type": "application/json" }
          });
        }

        // Daily spending cap check
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const spendKey = `spend:${today}`;
        const dailySpend = parseFloat(await redis.get(spendKey) || "0");
        
        if (dailySpend >= SECURITY_CONFIG.DAILY_SPENDING_CAP) {
          return new Response(JSON.stringify({ 
            error: "daily_budget_exceeded",
            message: `Daily spending cap of $${SECURITY_CONFIG.DAILY_SPENDING_CAP} reached. Resets at midnight UTC.`
          }), {
            status: 429,
            headers: { "content-type": "application/json" }
          });
        }
      }

      // 3) Parse request body
      let body = {};
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ 
          error: "invalid_json",
          message: "Request body must be valid JSON"
        }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }

      // 4) Validate prompt
      const prompt = (body.prompt || "").trim();
      
      if (!prompt || prompt.length < SECURITY_CONFIG.MIN_PROMPT_LENGTH) {
        return new Response(JSON.stringify({ 
          error: "invalid_prompt",
          message: `Prompt must be at least ${SECURITY_CONFIG.MIN_PROMPT_LENGTH} characters`
        }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }

      if (prompt.length > SECURITY_CONFIG.MAX_PROMPT_LENGTH) {
        return new Response(JSON.stringify({ 
          error: "prompt_too_long",
          message: `Prompt must be less than ${SECURITY_CONFIG.MAX_PROMPT_LENGTH} characters`
        }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }

      // 5) Content filtering
      const promptLower = prompt.toLowerCase();
      const foundBlockedWord = SECURITY_CONFIG.BLOCKED_WORDS.find(word => 
        promptLower.includes(word)
      );
      
      if (foundBlockedWord) {
        return new Response(JSON.stringify({ 
          error: "inappropriate_prompt",
          message: "Prompt contains inappropriate content"
        }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }

      // 6) Generate image
      try {
        const imageBytes = await generateImage(prompt, env);

        // Validate image size
        if (imageBytes.length > 5 * 1024 * 1024) { // 5MB max
          return new Response(JSON.stringify({ 
            error: "image_too_large",
            message: "Generated image exceeds size limit"
          }), {
            status: 500,
            headers: { "content-type": "application/json" }
          });
        }

        // 7) Update spending tracker
        if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
          const redis = Redis.fromEnv(env);
          const today = new Date().toISOString().split('T')[0];
          const spendKey = `spend:${today}`;
          const costPerImage = 0.004; // Approximate cost for Stability AI
          
          // Increment daily spend
          const currentSpend = parseFloat(await redis.get(spendKey) || "0");
          await redis.set(spendKey, String(currentSpend + costPerImage), {
            ex: 86400 * 2 // Expire after 2 days
          });
        }

        // 8) Store in R2 (both history and latest)
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const historyKey = `art/${timestamp}.jpg`;
        const latestKey = `art/latest.jpg`;

        await Promise.all([
          // History version (immutable, cache forever)
          env.ART.put(historyKey, imageBytes, {
            httpMetadata: {
              contentType: "image/jpeg",
              cacheControl: "public, max-age=31536000, immutable"
            }
          }),
          // Latest version (always fresh)
          env.ART.put(latestKey, imageBytes, {
            httpMetadata: {
              contentType: "image/jpeg",
              cacheControl: "no-store, max-age=0"
            }
          })
        ]);

        // 9) Return URLs
        const origin = `${url.protocol}//${url.host}`;
        return new Response(JSON.stringify({
          latestUrl: `${origin}/art/latest.jpg`,
          historyUrl: `${origin}/${historyKey}`,
          prompt: prompt
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });

      } catch (error) {
        console.error("Generation error:", error);
        
        // Better error messages
        let errorMessage = "generation_failed";
        let statusCode = 500;
        let userMessage = "Image generation failed. Please try again.";

        if (error.message?.includes("insufficient_credits") || error.message?.includes("402")) {
          errorMessage = "insufficient_credits";
          statusCode = 402;
          userMessage = "AI provider credits exhausted. Please contact administrator.";
        } else if (error.message?.includes("timeout") || error.message?.includes("ETIMEDOUT")) {
          errorMessage = "timeout";
          statusCode = 504;
          userMessage = "Request timed out. Please try again.";
        } else if (error.message?.includes("rate_limit") || error.message?.includes("429")) {
          errorMessage = "ai_provider_rate_limit";
          statusCode = 429;
          userMessage = "AI provider is rate limiting. Please wait a moment.";
        } else if (error.message?.includes("invalid_prompt") || error.message?.includes("400")) {
          errorMessage = "invalid_prompt_for_provider";
          statusCode = 400;
          userMessage = "Prompt was rejected by AI provider. Try different wording.";
        }

        return new Response(JSON.stringify({ 
          error: errorMessage,
          message: userMessage
        }), {
          status: statusCode,
          headers: { "content-type": "application/json" }
        });
      }
    }

    // ========================================
    // GET /art/* → Serve images from R2
    // ========================================
    if (request.method === "GET" && url.pathname.startsWith("/art/")) {
      const key = url.pathname.slice(1); // Remove leading slash
      const object = await env.ART.get(key);

      if (!object) {
        return new Response("Image not found", { status: 404 });
      }

      // Create headers from R2 object metadata
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("access-control-allow-origin", "*"); // CORS for browser preview

      return new Response(object.body, { headers });
    }

    // ========================================
    // GET /health → Health check endpoint
    // ========================================
    if (request.method === "GET" && url.pathname === "/health") {
      const health = {
        status: "ok",
        timestamp: new Date().toISOString(),
        version: "1.0.0"
      };
      
      // Check if Upstash is configured
      if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
        health.rateLimit = "enabled";
      } else {
        health.rateLimit = "disabled";
      }
      
      return new Response(JSON.stringify(health), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    // ========================================
    // GET / → Serve the frontend
    // ========================================
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(HTML, {
        headers: { "content-type": "text/html;charset=UTF-8" }
      });
    }

    // Default 404
    return new Response("Not found", { status: 404 });
  }
};

// ========================================
// Embedded HTML Frontend
// ========================================
const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AI Gallery Demo</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem 1rem;
      background: #0f0f0f;
      color: #e0e0e0;
    }
    h1 {
      font-size: 2rem;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .subtitle {
      color: #888;
      margin-bottom: 2rem;
    }
    form {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
    }
    input {
      flex: 1;
      padding: 0.75rem;
      border: 1px solid #333;
      border-radius: 8px;
      background: #1a1a1a;
      color: #e0e0e0;
      font-size: 1rem;
    }
    input:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      padding: 0.75rem 1.5rem;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: transform 0.2s;
    }
    button:hover:not(:disabled) {
      transform: translateY(-2px);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    #status {
      padding: 0.75rem;
      border-radius: 8px;
      margin-bottom: 1rem;
      display: none;
    }
    #status.show {
      display: block;
    }
    #status.loading {
      background: #1e3a5f;
      color: #60a5fa;
    }
    #status.success {
      background: #1e3a2f;
      color: #4ade80;
    }
    #status.error {
      background: #3a1e1e;
      color: #f87171;
    }
    #preview {
      max-width: 100%;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      display: none;
    }
    #preview.show {
      display: block;
    }
    .api-key-info {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1.5rem;
      font-size: 0.9rem;
      color: #888;
    }
    .api-key-info code {
      background: #0f0f0f;
      padding: 2px 6px;
      border-radius: 4px;
      color: #60a5fa;
    }
  </style>
</head>
<body>
  <h1>AI Gallery Demo</h1>
  <p class="subtitle">Generate AI art with a simple prompt</p>

  <div class="api-key-info">
    <strong>🛡️ Protected Demo</strong><br>
    Rate limited: 10 requests/min per user · 100 requests/hour globally<br>
    Prompt limits: 3-500 characters · Content filtered for safety
  </div>

  <form id="gen">
    <input 
      id="prompt" 
      placeholder="e.g., cubist dog in a modern gallery" 
      required
      minlength="3"
      maxlength="500"
    >
    <button type="submit">Generate</button>
  </form>

  <div id="status"></div>
  <img id="preview" alt="Generated artwork" />

  <script>
    const form = document.getElementById('gen');
    const status = document.getElementById('status');
    const preview = document.getElementById('preview');
    const promptInput = document.getElementById('prompt');

    function showStatus(message, type) {
      status.textContent = message;
      status.className = 'show ' + type;
    }

    function hideStatus() {
      status.className = '';
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const prompt = promptInput.value.trim();
      
      // Client-side validation
      if (!prompt || prompt.length < 3) {
        showStatus('✗ Prompt must be at least 3 characters', 'error');
        setTimeout(hideStatus, 3000);
        return;
      }
      
      if (prompt.length > 500) {
        showStatus('✗ Prompt must be less than 500 characters', 'error');
        setTimeout(hideStatus, 3000);
        return;
      }

      showStatus('Generating artwork...', 'loading');
      preview.classList.remove('show');
      form.querySelector('button').disabled = true;

      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ prompt })
        });

        const data = await res.json();

        if (!res.ok) {
          // Show user-friendly error message
          const errorMsg = data.message || data.error || 'Generation failed';
          throw new Error(errorMsg);
        }

        showStatus('✓ Generated successfully!', 'success');
        
        // Add cache-busting timestamp to force reload
        preview.src = data.historyUrl + '?t=' + Date.now();
        preview.classList.add('show');
        
        // Clear status after 3 seconds
        setTimeout(hideStatus, 3000);

      } catch (error) {
        const errorMsg = error.message || 'Generation failed';
        showStatus('✗ ' + errorMsg, 'error');
        
        // Auto-hide error after 8 seconds
        setTimeout(hideStatus, 8000);
      } finally {
        form.querySelector('button').disabled = false;
      }
    });
  </script>
</body>
</html>`;

async function generateImage(prompt, env) {
  const response = await fetch(
    'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STABILITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text_prompts: [{ text: prompt }],
        cfg_scale: 7,
        height: 1024,
        width: 1024,
        steps: 30,
        samples: 1,
      }),
    }
  );

  const data = await response.json();
  const base64 = data.artifacts[0].base64;
  
  // Convert base64 to bytes
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

