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

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
          "Access-Control-Max-Age": "86400",
        }
      });
    }

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
    // GET /api/images/latest - Get the latest image
    // ========================================
    if (request.method === "GET" && url.pathname === "/api/images/latest") {
      try {
        const list = await env.ART.list({ prefix: "art/", limit: 1000 });
        
        // Get the most recent non-latest.jpg image
        const latestImage = list.objects
          .filter(obj => obj.key !== "art/latest.jpg")
          .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))[0];
        
        if (!latestImage) {
          return new Response(JSON.stringify({ error: "no_images_found" }), {
            status: 404,
            headers: { 
              "content-type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }
        
        return new Response(JSON.stringify({
          url: `${url.protocol}//${url.host}/${latestImage.key}`,
          key: latestImage.key,
          uploaded: latestImage.uploaded.toISOString(),
          size: latestImage.size
        }), {
          status: 200,
          headers: { 
            "content-type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "failed_to_get_latest" }), {
          status: 500,
          headers: { 
            "content-type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
    }

    // ========================================
    // GET /api/images - List all generated images
    // ========================================
    if (request.method === "GET" && url.pathname === "/api/images") {
      try {
        const list = await env.ART.list({ prefix: "art/", limit: 100 });
        
        const images = list.objects
          .filter(obj => obj.key !== "art/latest.jpg")
          .map(obj => ({
            url: `${url.protocol}//${url.host}/${obj.key}`,
            key: obj.key,
            uploaded: obj.uploaded.toISOString(),
            size: obj.size
          }))
          .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
        
        return new Response(JSON.stringify({ 
          count: images.length,
          images: images 
        }), {
          status: 200,
          headers: { 
            "content-type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "failed_to_list_images" }), {
          status: 500,
          headers: { 
            "content-type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
    }

    // ========================================
    // POST /api/generate-sculpture - Generate 3D from IMAGE (2-step process)
    // ========================================
    if (request.method === "POST" && url.pathname === "/api/generate-sculpture") {
      try {
        // Parse request
        const body = await request.json();
        const prompt = body.prompt || "";
        
        if (!prompt || prompt.length < 3) {
          return new Response(JSON.stringify({ 
            error: "invalid_prompt",
            message: "Prompt must be at least 3 characters"
          }), {
            status: 400,
            headers: { 
              "content-type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }
        
        console.log(`Starting 2-step sculpture generation for: "${prompt}"`);
        const startTime = Date.now();
        
        // STEP 1: Generate 2D image from text prompt
        console.log('Step 1: Generating 2D image...');
        const imageResponse = await fetch(
          'https://api.stability.ai/v2beta/stable-image/generate/sd3',
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.STABILITY_API_KEY}`,
              'Accept': 'image/*'
            },
            body: (() => {
              const fd = new FormData();
              fd.append('prompt', prompt);
              fd.append('model', 'sd3-large-turbo');
              fd.append('aspect_ratio', '1:1');
              fd.append('output_format', 'png');
              return fd;
            })()
          }
        );
        
        if (!imageResponse.ok) {
          const errorText = await imageResponse.text();
          throw new Error(`Image generation failed: ${imageResponse.status} - ${errorText}`);
        }
        
        const imageData = await imageResponse.json();
        const imageBase64 = imageData.artifacts[0].base64;
        
        // Convert base64 to binary
        const imageBinary = atob(imageBase64);
        const imageBytes = new Uint8Array(imageBinary.length);
        for (let i = 0; i < imageBinary.length; i++) {
          imageBytes[i] = imageBinary.charCodeAt(i);
        }
        
        const imageGenTime = Date.now() - startTime;
        console.log(`Step 1 complete: Image generated in ${imageGenTime}ms`);
        
        // STEP 2: Convert image to 3D using Stable Fast 3D
        console.log('Step 2: Converting image to 3D...');
        const step2Start = Date.now();
        
        // Create form data with the image
        const formData = new FormData();
        formData.append('image', new Blob([imageBytes], { type: 'image/png' }), 'input.png');
        formData.append('texture_resolution', '1024');
        formData.append('foreground_ratio', '0.85');
        
        const sculptureResponse = await fetch(
          'https://api.stability.ai/v2beta/3d/stable-fast-3d',
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.STABILITY_API_KEY}`
              // Note: Don't set Content-Type, FormData handles it
            },
            body: formData
          }
        );
        
        if (!sculptureResponse.ok) {
          const errorText = await sculptureResponse.text();
          throw new Error(`3D generation failed: ${sculptureResponse.status} - ${errorText}`);
        }
        
        // Get GLB data (immediate response!)
        const glbData = await sculptureResponse.arrayBuffer();
        const sculptureGenTime = Date.now() - step2Start;
        console.log(`Step 2 complete: 3D generated in ${sculptureGenTime}ms`);
        
        // STEP 3: Store GLB in R2
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `sculpture-${timestamp}.glb`;
        const key = `sculptures/${filename}`;
        
        await env.ART.put(key, glbData, {
          httpMetadata: {
            contentType: 'model/gltf-binary',
            cacheControl: 'public, max-age=31536000, immutable'
          }
        });
        
        const totalTime = Date.now() - startTime;
        console.log(`Sculpture complete! Total time: ${totalTime}ms, stored: ${key}`);
        
        // STEP 4: Return response
        const origin = `${url.protocol}//${url.host}`;
        return new Response(JSON.stringify({
          url: `${origin}/${key}`,
          key: key,
          prompt: prompt,
          generationTime: Math.round(totalTime / 1000), // seconds
          size: glbData.byteLength,
          note: 'Generated from 2D image of prompt (image-to-3D)',
          timing: {
            imageGeneration: Math.round(imageGenTime / 1000),
            sculptureGeneration: Math.round(sculptureGenTime / 1000),
            total: Math.round(totalTime / 1000)
          }
        }), {
          status: 200,
          headers: { 
            'content-type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
        
      } catch (error) {
        console.error('Sculpture generation error:', error);
        return new Response(JSON.stringify({
          error: 'generation_failed',
          message: error.message || 'Failed to generate sculpture'
        }), {
          status: 500,
          headers: { 
            'content-type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // ========================================
    // GET /sculptures/*.glb - Serve sculpture files
    // ========================================
    if (request.method === "GET" && url.pathname.startsWith("/sculptures/")) {
      const key = url.pathname.slice(1); // Remove leading slash
      const object = await env.ART.get(key);
      
      if (!object) {
        return new Response("Sculpture not found", { status: 404 });
      }
      
      const headers = new Headers();
      headers.set("content-type", "model/gltf-binary");
      headers.set("access-control-allow-origin", "*");
      headers.set("cache-control", "public, max-age=31536000, immutable");
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      
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
    
    /* Sculpture Generation Styles */
    .sculpture-section {
      margin-top: 3rem;
      padding-top: 2rem;
      border-top: 2px solid #333;
    }
    .sculpture-section h2 {
      font-size: 1.5rem;
      margin-bottom: 1rem;
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .generate-btn {
      width: 100%;
      padding: 1rem;
      margin-bottom: 1.5rem;
    }
    .status-box {
      margin-top: 1.5rem;
      padding: 1.5rem;
      background: #1a1a1a;
      border-radius: 8px;
      border: 1px solid #333;
      display: none;
    }
    .status-box.show {
      display: block;
    }
    .status-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    #sculpture-status-text {
      font-weight: 600;
      color: #e0e0e0;
    }
    #sculpture-timer {
      font-family: 'Courier New', monospace;
      font-size: 1.1rem;
      color: #60a5fa;
      font-weight: bold;
    }
    .progress-bar {
      width: 100%;
      height: 24px;
      background: #0f0f0f;
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 1rem;
      border: 1px solid #333;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #667eea, #764ba2);
      width: 0%;
      transition: width 0.3s ease;
      border-radius: 12px;
    }
    .status-message {
      margin: 0;
      font-size: 0.9rem;
      color: #888;
      font-style: italic;
    }
    .complete-box {
      margin-top: 1.5rem;
      padding: 1.5rem;
      background: #1e3a2f;
      border: 1px solid #2d5a45;
      border-radius: 8px;
      display: none;
    }
    .complete-box.show {
      display: block;
    }
    .complete-box h3 {
      margin: 0 0 0.5rem 0;
      color: #4ade80;
    }
    .complete-box p {
      color: #a0d4b8;
      margin: 0.5rem 0;
    }
    .sculpture-info {
      margin-top: 1rem;
      font-size: 0.9rem;
    }
    .sculpture-info p {
      margin: 0.5rem 0;
      color: #a0d4b8;
    }
    .sculpture-info code {
      background: #0f0f0f;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 0.85rem;
      color: #60a5fa;
      word-break: break-all;
    }
    
    /* Responsive */
    @media (max-width: 768px) {
      .sculpture-section {
        padding-top: 1rem;
      }
      .status-header {
        flex-direction: column;
        align-items: flex-start;
        gap: 0.5rem;
      }
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
    <button type="submit">Generate Image</button>
  </form>

  <div id="status"></div>
  <img id="preview" alt="Generated artwork" />
  
  <!-- 3D Sculpture Generation Section -->
  <div class="sculpture-section">
    <h2>🗿 3D Sculpture Generation</h2>
    
    <button id="generate-sculpture-btn" class="generate-btn">
      Generate 3D Sculpture
    </button>
    
    <div id="sculpture-status" class="status-box">
      <div class="status-header">
        <span id="sculpture-status-text">Generating sculpture...</span>
        <span id="sculpture-timer">0s</span>
      </div>
      <div class="progress-bar">
        <div id="sculpture-progress" class="progress-fill"></div>
      </div>
      <p id="sculpture-message" class="status-message"></p>
    </div>
    
    <div id="sculpture-complete" class="complete-box">
      <h3>✅ Sculpture Generated!</h3>
      <p>Ready to view in Unity gallery</p>
      <div class="sculpture-info">
        <p><strong>Key:</strong> <code id="sculpture-key"></code></p>
        <p><strong>Generation Time:</strong> <span id="sculpture-time"></span> seconds</p>
        <p><strong>File Size:</strong> <span id="sculpture-size"></span> MB</p>
      </div>
    </div>
  </div>

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

    // Image Generation
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

    // Sculpture Generation
    let sculptureTimerInterval = null;
    
    document.getElementById('generate-sculpture-btn').addEventListener('click', async () => {
      const prompt = promptInput.value.trim();
      
      if (!prompt || prompt.length < 3) {
        showStatus('✗ Please enter a prompt first (at least 3 characters)!', 'error');
        setTimeout(hideStatus, 3000);
        return;
      }
      
      // Disable button
      const button = document.getElementById('generate-sculpture-btn');
      button.disabled = true;
      button.textContent = 'Generating...';
      
      // Show status box
      document.getElementById('sculpture-status').classList.add('show');
      document.getElementById('sculpture-complete').classList.remove('show');
      
      // Reset progress
      document.getElementById('sculpture-progress').style.width = '0%';
      document.getElementById('sculpture-status-text').textContent = 'Starting generation...';
      document.getElementById('sculpture-message').textContent = 'Sending request to AI...';
      
      // Clear any existing timer
      if (sculptureTimerInterval) {
        clearInterval(sculptureTimerInterval);
      }
      
      // Start timer
      let startTime = Date.now();
      sculptureTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        document.getElementById('sculpture-timer').textContent = elapsed + 's';
        
        // Update progress bar (estimate: ~15 seconds total)
        const estimatedProgress = Math.min((elapsed / 15) * 100, 95);
        document.getElementById('sculpture-progress').style.width = estimatedProgress + '%';
        
        // Update messages based on time
        if (elapsed < 3) {
          document.getElementById('sculpture-message').textContent = 'Step 1: Generating 2D image from prompt...';
        } else if (elapsed < 12) {
          document.getElementById('sculpture-message').textContent = 'Step 2: Converting image to 3D sculpture...';
        } else {
          document.getElementById('sculpture-message').textContent = 'Step 3: Finalizing and storing...';
        }
      }, 1000);
      
      try {
        // Call API
        const response = await fetch('/api/generate-sculpture', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ prompt })
        });
        
        const data = await response.json();
        
        // Stop timer
        clearInterval(sculptureTimerInterval);
        sculptureTimerInterval = null;
        
        if (!response.ok || data.error) {
          throw new Error(data.message || data.error || 'Generation failed');
        }
        
        // Show completion animation
        document.getElementById('sculpture-progress').style.width = '100%';
        document.getElementById('sculpture-status-text').textContent = 'Complete!';
        document.getElementById('sculpture-message').textContent = '✅ Sculpture ready for Unity';
        
        setTimeout(() => {
          document.getElementById('sculpture-status').classList.remove('show');
          document.getElementById('sculpture-complete').classList.add('show');
          
          // Fill in details
          document.getElementById('sculpture-key').textContent = data.key;
          document.getElementById('sculpture-time').textContent = data.generationTime;
          document.getElementById('sculpture-size').textContent = (data.size / 1024 / 1024).toFixed(2);
        }, 1000);
        
      } catch (error) {
        if (sculptureTimerInterval) {
          clearInterval(sculptureTimerInterval);
          sculptureTimerInterval = null;
        }
        document.getElementById('sculpture-status-text').textContent = '❌ Generation failed';
        document.getElementById('sculpture-message').textContent = error.message;
        document.getElementById('sculpture-progress').style.width = '0%';
        document.getElementById('sculpture-progress').style.background = 'linear-gradient(90deg, #f87171, #ef4444)';
        
        // Reset progress color after 5 seconds
        setTimeout(() => {
          document.getElementById('sculpture-progress').style.background = 'linear-gradient(90deg, #667eea, #764ba2)';
        }, 5000);
      } finally {
        // Re-enable button
        button.disabled = false;
        button.textContent = 'Generate 3D Sculpture';
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

