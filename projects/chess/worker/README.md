# Chess Coach API - Cloudflare Worker

This Cloudflare Worker proxies requests to the Claude API for AI chess coaching.

## Setup

### Prerequisites

1. [Cloudflare account](https://dash.cloudflare.com/sign-up)
2. [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
3. [Anthropic API key](https://console.anthropic.com/)

### Installation

```bash
# Install Wrangler if not already installed
npm install -g wrangler

# Login to Cloudflare
wrangler login
```

### Configure Secrets

```bash
# Set your Anthropic API key (required)
wrangler secret put ANTHROPIC_API_KEY
# Paste your API key when prompted

# Set your Firebase project ID (required for auth verification)
wrangler secret put FIREBASE_PROJECT_ID
# Paste your Firebase project ID when prompted
```

### Deploy

```bash
# Deploy to development
wrangler deploy --env dev

# Deploy to production
wrangler deploy --env production
```

### Get Your Worker URL

After deployment, Wrangler will output your worker URL:
```
https://chess-coach.YOUR_SUBDOMAIN.workers.dev
```

Update this URL in `js/ai-coach.js`:
```javascript
WORKER_URL: 'https://chess-coach.YOUR_SUBDOMAIN.workers.dev',
```

## API Endpoints

### POST /api/coach

Send a coaching request to Claude.

**Headers:**
- `Authorization: Bearer <firebase-id-token>`
- `Content-Type: application/json`

**Body:**
```json
{
  "systemPrompt": "You are a chess coach...",
  "messages": [
    {
      "role": "user",
      "content": "Please analyze my games..."
    }
  ]
}
```

**Response:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "Based on your games..."
    }
  ]
}
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok"
}
```

## Security Notes

1. The worker verifies Firebase ID tokens before processing requests
2. API keys are stored as Cloudflare secrets, never in code
3. CORS is configured to allow cross-origin requests
4. Rate limiting is handled by Claude API (with helpful error messages)

## Cost Considerations

- Cloudflare Workers: Free tier includes 100,000 requests/day
- Claude API: Pay per token (see [Anthropic pricing](https://www.anthropic.com/pricing))
- Typical coaching request: ~$0.01-0.05 depending on game count
