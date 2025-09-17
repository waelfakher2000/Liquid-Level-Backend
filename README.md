````markdown
# LiquidLevel API (Node + Express)

Backend service for Liquid Level projects. It connects to MongoDB Atlas, optionally listens to MQTT (multi-broker, per project), and can send Firebase Cloud Messaging (FCM) notifications. Built with Node.js (ES modules), Express, MongoDB driver, mqtt, and firebase-admin.

## Quick Start

For deployment on Render, create a Web Service from this repository and set the environment variables below. The PORT is provided by Render automatically; you do not need to set it.

```
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster-host>/?retryWrites=true&w=majority&appName=liquidlevel
MONGODB_DB=liquidlevel
CORS_ORIGIN=*
# Optional (MQTT global override)
# If set, the bridge will use this single broker for all projects instead of each project's own broker.
MQTT_URL=tcp://broker.example.com:1883
MQTT_USERNAME=
MQTT_PASSWORD=
READINGS_TTL_DAYS=7
BRIDGE_REFRESH_MS=60000
# FCM (choose exactly one)
FIREBASE_SERVICE_ACCOUNT_JSON={...full JSON...}
# or
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
```


## Environment Variables

- MONGODB_URI (required): MongoDB Atlas connection string.
- MONGODB_DB (default: liquidlevel): Database name.
- PORT: Port to listen on. On Render this is injected automatically; do not set it manually there.
- CORS_ORIGIN (default: *): Allowed origins for CORS.
- MQTT_URL / MQTT_USERNAME / MQTT_PASSWORD (optional): Override broker connection for the MQTT bridge.
- READINGS_TTL_DAYS (optional): Retention for `readings` via TTL.
- BRIDGE_REFRESH_MS (default: 60000): How often to resync project subscriptions.
- FIREBASE_SERVICE_ACCOUNT_JSON (preferred) or GOOGLE_APPLICATION_CREDENTIALS: Enable FCM push notifications.

## Endpoints

- GET `/health` → { ok: true, info: { version } }
- GET `/projects` → List projects (from DB)
- POST `/projects` → Upsert project config for the bridge
   - Body supports per‑project MQTT and alerts:
      {
         id, name,
         broker, port, topic, username?, password?,
         storeHistory,
         multiplier?, offset?, sensorType?, tankType?,
         alertsEnabled?, alertLow?, alertHigh?, alertCooldownSec?, notifyOnRecover?
      }
- POST `/readings` → Store a reading
- GET `/readings` → Query readings for charts (projectId, from/to, limit)
- POST `/register-device` → Register a device FCM token (optional projectId)
- POST `/bridge/reload` → Manually refresh project subscriptions

## FCM Notifications (Optional)

If FCM is configured, incoming MQTT messages will be stored and a push notification will be sent to registered device tokens. Register device tokens via:

```
POST /register-device
Content-Type: application/json

{ "token": "<device_fcm_token>", "projectId": "<optional-project-id>" }
```

## Deploy to Render

1) Create a Web Service from this repository.
   - Build Command: `npm install`
   - Start Command: `npm start`

2) Set environment variables:

```
MONGODB_URI=...           # required
MONGODB_DB=liquidlevel    # optional
CORS_ORIGIN=*             # or your app origin(s)

MQTT_URL=...              # optional
MQTT_USERNAME=
MQTT_PASSWORD=
READINGS_TTL_DAYS=7
BRIDGE_REFRESH_MS=60000

# FCM (choose ONE)
FIREBASE_SERVICE_ACCOUNT_JSON={...full JSON...}
# or
GOOGLE_APPLICATION_CREDENTIALS=/opt/render/project/src/service-account.json
```

3) Open the service URL and check `/health`.

### Render Blueprint (optional)

The repo includes `render.yaml` for one‑click deploys.

### MQTT Bridge Behavior

- The bridge supports multiple brokers at the same time. Projects are grouped by their broker URL and credentials; one MQTT client is created per unique combination.
- If you set `MQTT_URL` (and optional username/password), it overrides and uses a single global broker for all projects. Unset `MQTT_URL` to use per‑project brokers.
- The bridge periodically resyncs subscriptions (default every 60s). You can also call `POST /bridge/reload` to refresh immediately.

#### Alerts

- If `alertsEnabled` is true for a project, incoming values are checked against `alertLow` and `alertHigh` thresholds (in meters, after applying `multiplier` and `offset`).
- Notifications are sent on threshold crossings (entering low/high from normal). Optionally, set `notifyOnRecover` to true to be notified when the level returns to normal.
- Use `alertCooldownSec` to avoid spam; the same project won't alert more than once per cooldown window.

### Troubleshooting (MongoDB Atlas)

- If you see TLS or handshake errors (for example, "tlsv1 alert internal error"), try:
   - Ensure your Atlas Project → Network Access allows connections from your Render service (allow 0.0.0.0/0 temporarily to verify connectivity).
   - Verify your MONGODB_URI is exactly as provided by Atlas (SRV URI, starts with `mongodb+srv://`).
   - Our server prefers IPv4 DNS results to avoid SRV/IPv6 quirks on some hosts.
   - Optionally set in Render Environment: `NODE_OPTIONS=--dns-result-order=ipv4first`.

````
