# AI Gallery# AI Gallery - Cloudflare Workers + R2



> **Production-ready AI art gallery** powered by Cloudflare Workers + R2A serverless AI art gallery with zero-egress-cost image storage and edge delivery.



Generate AI images from text prompts, store them in the cloud, and serve them globally via CDN — all with zero egress costs.## Architecture



---- **Frontend**: Embedded HTML (served from Worker)

- **API**: Cloudflare Worker (handles generation + serves images)

## ✨ Features- **Storage**: R2 (images stored with CDN delivery)

- **Security**: API key auth + optional rate limiting via Upstash

- 🎨 **AI Image Generation** - OpenAI DALL-E or Stability AI

- 🌍 **Global CDN** - Delivered from 270+ edge locations## Quick Start

- 🔒 **Production Security** - Rate limiting, spending caps, content filtering

- 💰 **Zero Egress** - Unlimited bandwidth at no cost### 1. Install Dependencies

- ⚡ **Edge-First** - <100ms response times globally

- 📦 **Simple Deploy** - One command to production```bash

npm install

---```



## 🚀 Quick Start### 2. Login to Cloudflare



### 1. Install & Setup```bash

npx wrangler login

```bash```

# Install dependencies

npm install### 3. Create R2 Bucket



# Login to Cloudflare```bash

npx wrangler loginnpx wrangler r2 bucket create ai-gallery-art

```

# Create storage bucket

npx wrangler r2 bucket create ai-gallery-art### 4. Set Required Secrets



# Generate & set API key```bash

openssl rand -base64 32  # Copy the output# Generate a random API key

npx wrangler secret put DEMO_API_KEY  # Paste the keynpx wrangler secret put DEMO_API_KEY

```# When prompted, paste a long random string like: sk_live_abc123xyz...

```

### 2. Deploy

### 5. (Optional) Add Rate Limiting

```bash

npm run deploy**Why?** Without rate limiting, anyone can spam your API → huge AI provider bills.

```

1. Create free [Upstash Redis](https://console.upstash.com/) account

Visit the URL shown to see your gallery! 🎉2. Create a Redis database

3. Copy the REST URL and Token

### 3. Add Real AI (Optional)4. Add to Wrangler:



**Stability AI** (cheaper, $0.003/image):```bash

```bashnpx wrangler secret put UPSTASH_REDIS_REST_URL

npx wrangler secret put STABILITY_API_KEY# Paste: https://xxx.upstash.io

# Uncomment lines 569-600 in src/worker.js

npm run deploynpx wrangler secret put UPSTASH_REDIS_REST_TOKEN

```# Paste: your token

```

**OpenAI DALL-E** (better quality, $0.04/image):

```bashRate limit: **10 requests per minute per IP**

npx wrangler secret put OPENAI_API_KEY

# Uncomment lines 541-565 in src/worker.js### 6. Deploy

npm run deploy

``````bash

npm run deploy

---```



## 📖 DocumentationYou'll get a URL like: `https://ai-gallery.your-subdomain.workers.dev`



- **Quick Start** - You're reading it## Testing

- **[CONTEXT.md](CONTEXT.md)** - Complete technical documentation (architecture, security, API, troubleshooting, production setup)

### Test the API

> **For LLMs/Developers**: See `CONTEXT.md` for full context including architecture decisions, security implementation, deployment details, and scaling strategies.

```bash

---curl -X POST https://your-worker.workers.dev/api/generate \

  -H "Content-Type: application/json" \

## 🔧 Common Commands  -H "X-API-Key: your-demo-api-key" \

  -d '{"prompt": "cyberpunk cityscape at night"}'

```bash```

npm run deploy          # Deploy to production

npm run dev             # Local developmentExpected response:

npx wrangler tail       # View live logs```json

npx wrangler secret put SECRET_NAME   # Add secret{

```  "latestUrl": "https://your-worker.workers.dev/art/latest.jpg",

  "historyUrl": "https://your-worker.workers.dev/art/2025-11-11T10-30-00-000Z.jpg",

---  "prompt": "cyberpunk cityscape at night"

}

## 💰 Cost Estimate```



| Service | Cost |### View the Image

|---------|------|

| Cloudflare Workers | **$0** (100k req/day free) |Open the `historyUrl` in your browser. The image should load instantly from R2.

| R2 Storage | **$0** (10GB free) |

| R2 Bandwidth | **$0** (unlimited free) |### Test the Frontend

| AI (Stability) | $3/1k images |

| AI (OpenAI) | $40/1k images |Visit `https://your-worker.workers.dev/` and use the form to generate images.

| **Total** | **$3-40/month** |

**Note**: The frontend currently has a placeholder API key. You have two options:

Everything except AI is free. 🎉

1. **Quick Demo**: Hardcode your API key in the HTML (NOT for production)

---2. **Production**: Remove client-side key requirement and validate server-side only



## 🏗️ Architecture## Switching to Real AI



```### Option 1: OpenAI DALL-E

User → Worker (Edge) → AI API → R2 Storage → CDN → User

         ↓1. Get an API key from [OpenAI](https://platform.openai.com/)

    Rate Limiting2. Add the secret:

    (Upstash Redis)

``````bash

npx wrangler secret put OPENAI_API_KEY

**Key Points**:```

- Runs in 270+ global locations (Cloudflare edge)

- Images cached at edge (10-50ms delivery)3. In `src/worker.js`, uncomment the OpenAI example and replace the stub function

- Multi-layer security (auth, rate limits, spending caps)

- Zero egress costs (vs $90/TB on S3)**Cost**: ~$0.04 per image (DALL-E 3 standard)



---### Option 2: Stability AI



## 🔒 Security Features1. Get an API key from [Stability AI](https://platform.stability.ai/)

2. Add the secret:

✅ **Same-origin authentication** - Frontend doesn't expose API key  

✅ **Multi-layer rate limiting** - Per-IP (10/min) + Global (100/hr)  ```bash

✅ **Daily spending cap** - $10/day default (configurable)  npx wrangler secret put STABILITY_API_KEY

✅ **Content filtering** - Blocks inappropriate prompts  ```

✅ **Request validation** - Size limits, prompt validation  

3. In `src/worker.js`, uncomment the Stability AI example

---

**Cost**: ~$0.003 per image (much cheaper)

## 🧪 Testing

### Option 3: Replicate

**Test the API**:

```bashSimilar process - see [Replicate docs](https://replicate.com/docs) for models.

curl -X POST https://your-worker.workers.dev/api/generate \

  -H "Content-Type: application/json" \## Project Structure

  -d '{"prompt": "mountain landscape"}'

``````

ai-gallery/

**Test rate limiting**:├── src/

```bash│   └── worker.js         # Main Worker (API + image serving + frontend)

for i in {1..11}; do├── wrangler.toml         # Cloudflare config

  curl -X POST https://your-worker.workers.dev/api/generate \├── package.json          # Dependencies

    -H "Content-Type: application/json" \└── README.md             # This file

    -d '{"prompt": "test"}';```

done

# 11th request should return 429## How It Works

```

1. **User submits prompt** → POST to `/api/generate`

---2. **Worker authenticates** → checks `X-API-Key` header

3. **Rate limit check** → (optional) via Upstash Redis

## 📁 Project Structure4. **Generate image** → currently a placeholder, swap for AI provider

5. **Store in R2**:

```   - `art/2025-11-11T10-30-00-000Z.jpg` (immutable history)

ai-gallery/   - `art/latest.jpg` (always the newest)

├── src/6. **Return URLs** → both images are now at the edge

│   └── worker.js          # Main application7. **User requests image** → GET `/art/...` streams from R2 (instant, worldwide)

├── wrangler.toml          # Cloudflare config

├── package.json           # Dependencies## Cost Breakdown (1,000 generations/month)

├── .dev.vars.example      # Example secrets

├── README.md              # This file| Service | Cost |

└── CONTEXT.md             # Complete documentation|---------|------|

```| **Cloudflare Workers** | Free (100k req/day included) |

| **R2 Storage** | ~$0.015 (10GB @ $0.015/GB) |

---| **R2 Egress** | **$0** (unlimited free) |

| **Upstash Redis** | Free (10k commands/day) |

## ⚠️ Troubleshooting| **AI Provider** | $40 (DALL-E) or $3 (Stability) |

| **Total** | **$3-40/month** |

**"Unauthorized" error**:

```bashCompare to S3: +$90/month for 1TB egress 🔥

npx wrangler secret put DEMO_API_KEY  # Reset key

```## Custom Domain (Optional)



**Deploy fails**:1. Add your domain to Cloudflare

```bash2. Add route in `wrangler.toml`:

rm -rf node_modules && npm install  # Reinstall

``````toml

routes = [

**More help**: See [CONTEXT.md](CONTEXT.md) → Troubleshooting section  { pattern = "gallery.yourdomain.com", custom_domain = true }

]

---```



## 🎯 Why This Stack?3. Deploy: `npm run deploy`



| vs Vercel + S3 | Cloudflare |## Monitoring

|----------------|------------|

| Egress (1TB) | **$0** vs $90 |View logs in real-time:

| CDN | Included vs Extra setup |

| Cold starts | 0-1ms vs 3-5s |```bash

| Deploy time | 10min vs 2-3hrs |npx wrangler tail

```

**Full comparison**: See [CONTEXT.md](CONTEXT.md) → Architecture section

Or check the [Cloudflare Dashboard](https://dash.cloudflare.com/) for analytics.

---

## Security Checklist

## 📚 Learn More

- [x] API key authentication (prevents unauthorized use)

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)- [x] Rate limiting (prevents abuse/spam)

- [R2 Storage Docs](https://developers.cloudflare.com/r2/)- [x] CORS properly configured (browser preview works)

- [Upstash Redis Docs](https://docs.upstash.com/)- [ ] Consider adding request signing for production

- [ ] Monitor usage via Cloudflare Analytics

---

## Troubleshooting

## 📞 Support

### "Unauthorized" error

- [Cloudflare Discord](https://discord.gg/cloudflaredev)

- [Stack Overflow](https://stackoverflow.com/questions/tagged/cloudflare-workers)- Check that you set `DEMO_API_KEY` secret

- Verify the `X-API-Key` header matches your secret

---

### "Rate limit exceeded"

**Ready to deploy?** Run `npm run deploy` and start generating art in minutes! 🎨

- Wait 1 minute, then retry
- Or increase the limit in `src/worker.js` (line 24)

### Images not loading

- Confirm R2 bucket name matches `wrangler.toml` (line 7)
- Check Worker logs: `npx wrangler tail`

### CORS errors in browser

- Already handled in the code (line 115)
- If issues persist, check browser console for specific error

## Development

Local development with live reload:

```bash
npm run dev
```

This starts a local server at `http://localhost:8787`

**Note**: You'll need to set secrets for local dev:

```bash
# Create .dev.vars file (gitignored)
echo 'DEMO_API_KEY=your-key-here' > .dev.vars
echo 'UPSTASH_REDIS_REST_URL=https://...' >> .dev.vars
echo 'UPSTASH_REDIS_REST_TOKEN=...' >> .dev.vars
```

## Next Steps

- [ ] Replace stub image generator with real AI
- [ ] Add image history page (list all generated images)
- [ ] Add metadata storage (prompts, timestamps, etc.)
- [ ] Implement user authentication (Clerk, WorkOS, etc.)
- [ ] Add image editing/variations
- [ ] Set up monitoring alerts

## Why This Stack?

| Decision | Rationale |
|----------|-----------|
| Workers over Vercel | Simpler (one provider), faster edge execution |
| R2 over S3 | Zero egress costs, built-in CDN |
| Embedded HTML | No build step, instant updates |
| Upstash | Free tier sufficient, edge-compatible |

**Total complexity**: One file, one provider, zero configuration. 

## Support

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [R2 Documentation](https://developers.cloudflare.com/r2/)
- [Upstash Rate Limiting](https://upstash.com/docs/redis/features/ratelimiting)

---

**Built with Cloudflare Workers** ⚡
