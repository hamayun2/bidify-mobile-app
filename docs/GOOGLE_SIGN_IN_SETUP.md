# Google Sign-In (Bidify mobile)

Additive auth: native Google ID token → `supabase.auth.signInWithIdToken({ provider: 'google', token })`.

**Does not work in Expo Go** — use a development build:

```bash
npx expo run:android
# or
npx expo run:ios
```

## 1. Install (project root)

```bash
npx expo install @react-native-google-signin/google-signin
```

After changing `app.config.js` or env, rebuild the native app (not just `expo start`).

## 2. Environment variables (`.env`)

```env
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=YOUR_WEB_CLIENT_ID.apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=YOUR_IOS_CLIENT_ID.apps.googleusercontent.com
# Reversed iOS client ID for the Expo config plugin (Google Cloud → iOS OAuth client)
EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME=com.googleusercontent.apps.YOUR_IOS_CLIENT_NUMERIC_PART
```

- **Web client ID** must be the OAuth **Web application** client (used for the ID token Supabase validates).
- **iOS client ID** is the iOS OAuth client from the same Google Cloud project.
- **iOS URL scheme** is the “iOS URL scheme” shown in Google’s iOS client setup (starts with `com.googleusercontent.apps.`).

Restart with cache clear:

```bash
npx expo start --clear
```

## 3. Google Cloud Console

1. Create OAuth clients: **Web**, **Android**, **iOS** (same project).
2. Web client: authorized origins optional for native; ensure client exists for Supabase.
3. Android: package name + SHA-1 from your dev keystore (`keytool` / EAS credentials).
4. iOS: bundle identifier must match `expo.ios.bundleIdentifier` if you set one.

## 4. Supabase Dashboard

**Authentication → Providers → Google**

- Enable Google.
- Paste the **Web client ID** and **Web client secret** from Google Cloud.
- Save.

No new SQL tables or RLS changes are required for this feature.

## 5. Deep linking (`bidify://`)

`app.json` already includes:

```json
"scheme": "bidify"
```

`getSupabaseAuthRedirectUrl()` resolves to URLs like:

- `bidify://auth/callback` (production / dev client)
- `exp://…/--/auth/callback` (Expo dev)

**Supabase → Authentication → URL Configuration → Redirect URLs**, add:

- `bidify://auth/callback`
- `exp://127.0.0.1:8086/--/auth/callback` (adjust port if you use another)
- `exp://localhost:8086/--/auth/callback`

Google native sign-in does not rely on this redirect for the token exchange; redirects are still used for email confirmation / password reset.

## 6. Local development checklist

| Step | Action |
|------|--------|
| Env | Fill the three `EXPO_PUBLIC_GOOGLE_*` variables |
| Supabase | Enable Google provider with Web client secret |
| Build | `npx expo run:android` or `run:ios` (not Expo Go) |
| Test | Login screen → **Sign in with Google** |

## 7. Files touched (app code)

| File | Role |
|------|------|
| `src/services/googleAuthService.js` | Configure SDK, get `idToken`, Supabase `signInWithIdToken` |
| `src/api/auth.js` | `loginWithGoogleAPI()` |
| `src/screens/LoginScreen.js` | Google button + divider |
| `src/components/GoogleSignInButton.js` | UI |
| `app.config.js` | Expo plugin `iosUrlScheme` from env |
| `.env.example` | Placeholder variable names |

Email/password login paths are unchanged.
