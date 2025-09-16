<<<<<<< HEAD
# Liquid-Level-Backend
=======
# LiquidLevel API (Node + Express)

Minimal backend API that connects to MongoDB Atlas using the official driver and keeps credentials outside the Flutter app.

## Setup

1. Copy .env.example to .env and fill values:

```
MONGODB_URI=mongodb+srv://waelfakher4_db_user:<PASSWORD>@liquidlevel.z2sod5d.mongodb.net/?retryWrites=true&w=majority&appName=liquidlevel
MONGODB_DB=liquidlevel
PORT=8080
CORS_ORIGIN=*
```

2. Install deps and run (Windows PowerShell):

```
cd api
npm install
npm run dev
```

- http://localhost:8080/projects

- For production, prefer hosting on a secure environment and keep the MONGODB_URI secret in the host.

## Optional: Enable FCM push notifications

This API can push Firebase Cloud Messaging (FCM) notifications to devices when MQTT readings arrive.

1. Add Firebase Admin credentials:
	- Place your Firebase service account JSON at `api/service-account.json`, or set an environment variable `GOOGLE_APPLICATION_CREDENTIALS` to the absolute path of the file.
2. Install dependencies (already added to package.json):
	- `firebase-admin`
3. Register device tokens from the app by calling:

```
POST /register-device
Content-Type: application/json

{ "token": "<device_fcm_token>", "projectId": "<optional-project-id>" }
```
- If `projectId` is omitted, the token is considered global and will receive notifications for all projects. If set, the token receives for that project only.

When a message is received on a subscribed MQTT topic, the bridge stores the reading to MongoDB and (if FCM is enabled) sends a push notification to the registered tokens.

## Deploying to Render

1) Push this `api/` folder to its own GitHub repository (see steps below).

2) On Render, create a new Web Service connected to that repo:
	- Runtime: Node
	- Build Command: `npm install`
	- Start Command: `npm start`
	- Environment: set the following variables:

```
MONGODB_URI=...           # required
MONGODB_DB=liquidlevel    # optional
PORT=10000                # Render sets PORT automatically; you can leave it unset
CORS_ORIGIN=*             # or your app origin(s)

# Optional MQTT and retention settings
MQTT_URL=tcp://broker:1883
MQTT_USERNAME=
MQTT_PASSWORD=
READINGS_TTL_DAYS=7
BRIDGE_REFRESH_MS=60000

# FCM (choose ONE of the following)
FIREBASE_SERVICE_ACCOUNT_JSON={...full JSON...}
# or
GOOGLE_APPLICATION_CREDENTIALS=/opt/render/project/src/service-account.json
```

3) If using `GOOGLE_APPLICATION_CREDENTIALS`, add `service-account.json` to the repo or Render secrets storage. Prefer using `FIREBASE_SERVICE_ACCOUNT_JSON` to avoid committing files.

### Split `api/` to a new GitHub repo (Windows PowerShell)

From the project root:

```
cd api
git init
git add .
git commit -m "Initial commit: LiquidLevel API"
# Create a new empty repo on GitHub first, then set it here:
git remote add origin https://github.com/<your-user>/<new-repo>.git
git branch -M main
git push -u origin main
```

Then, in Render, pick this new repository when creating the Web Service.
>>>>>>> 3ec53ba (Initial commit: LiquidLevel API)
