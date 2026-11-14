#!/usr/bin/env bash
#
# setup-firebase.sh — Bootstrap a FreeField BYO Firebase deployment.
#
# Per plan v3 §6.5: each company deploying FreeField runs this against
# their own Firebase project. Does:
#
#   1. firebase use --add (interactive project selector, or pass PROJECT_ID)
#   2. Enable Firebase Auth (email-link only — no email/password, no OAuth)
#   3. Deploy firestore.rules + firestore.indexes.json
#   4. Build + deploy Cloud Functions (Phase 1: bootstrapFirstAdmin only)
#   5. Configure Firebase Auth Authorized Domains (incl. custom domain if --custom-domain)
#   6. Set GCP billing budget alert ($100/mo threshold)
#   7. Prompt for first admin email + invoke bootstrapFirstAdmin
#
# Usage:
#   ./scripts/setup-firebase.sh [--project PROJECT_ID] [--custom-domain freefield.acme.com]
#
# Prerequisites:
#   - firebase-tools installed: npm install -g firebase-tools
#   - firebase login (run once per machine)
#   - gcloud CLI installed (for billing alert)
#
# Phase 0 note: this script is a Phase 1 deliverable. The Phase 0 spike runs
# `firebase deploy --only firestore:rules,firestore:indexes` + manual setup;
# full automation lands when Cloud Functions deploy is wired in.

set -euo pipefail

PROJECT_ID=""
CUSTOM_DOMAIN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="$2"
      shift 2
      ;;
    --custom-domain)
      CUSTOM_DOMAIN="$2"
      shift 2
      ;;
    --region)
      FUNCTIONS_REGION="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--project PROJECT_ID] [--custom-domain DOMAIN] [--region REGION]"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1"
      exit 1
      ;;
  esac
done

FUNCTIONS_REGION="${FUNCTIONS_REGION:-us-central1}"

# --- 1. Project selection ---
if [ -n "$PROJECT_ID" ]; then
  echo "Using Firebase project: $PROJECT_ID"
  firebase use --add "$PROJECT_ID" --alias default || firebase use "$PROJECT_ID"
else
  echo "No --project flag given. Running interactive selector..."
  firebase use --add
fi

ACTIVE_PROJECT=$(firebase projects:list --json | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['projectId'])" 2>/dev/null || firebase use)
echo "Active project: $ACTIVE_PROJECT"

# --- 2. Enable Firebase Auth ---
echo ""
echo "Enabling Firebase Authentication (email-link only)..."
echo "NOTE: Do this step manually in Firebase Console if the CLI prompts:"
echo "  → Firebase Console → Authentication → Sign-in method"
echo "  → Enable 'Email/Password' provider (yes, the link-based flow needs this)"
echo "  → Then in the same Email/Password provider, enable 'Email link (passwordless sign-in)'"
echo "  → DO NOT enable Google, Facebook, or any other OAuth providers in v1"
echo ""
read -p "Press Enter to continue once enabled in Console, or Ctrl-C to abort..."

# --- 3. Deploy Firestore rules + indexes ---
echo ""
echo "Deploying firestore.rules + firestore.indexes.json..."
firebase deploy --only firestore:rules,firestore:indexes --project "$ACTIVE_PROJECT"

# --- 4. Build + deploy Cloud Functions (Phase 1) ---
if [ -d "packages/ff-firestore/functions" ]; then
  echo ""
  echo "Building + deploying Cloud Functions..."
  (cd packages/ff-firestore/functions && npm install && npm run build)
  firebase deploy --only functions --project "$ACTIVE_PROJECT"
else
  echo ""
  echo "Skipping Cloud Functions deploy (packages/ff-firestore/functions not present)."
  echo "Phase 0 spike doesn't need Functions runtime; Phase 1 will deploy bootstrapFirstAdmin."
fi

# --- 5. Authorized domains ---
echo ""
echo "Configuring Firebase Auth Authorized Domains..."
AUTHED_DOMAINS=$(firebase auth:export --project "$ACTIVE_PROJECT" --format=json 2>/dev/null || echo "[]")
echo "Existing authorized domains:"
echo "$AUTHED_DOMAINS" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2))" 2>/dev/null || echo "(unable to enumerate — configure manually)"

if [ -n "$CUSTOM_DOMAIN" ]; then
  echo ""
  echo "Adding custom domain $CUSTOM_DOMAIN to authorized domains..."
  firebase auth:import /dev/null --project "$ACTIVE_PROJECT" 2>/dev/null || true
  echo "NOTE: Firebase auth:import doesn't manage authorized domains. Add manually:"
  echo "  → Firebase Console → Authentication → Sign-in method → Authorized domains"
  echo "  → Add: $CUSTOM_DOMAIN"
  echo ""
  echo "For iOS Universal Links (Phase 3+), also host apple-app-site-association at:"
  echo "  https://$CUSTOM_DOMAIN/.well-known/apple-app-site-association"
fi

# --- 6. Billing budget alert ---
echo ""
echo "Setting GCP billing budget alert (\$100/mo threshold)..."
if command -v gcloud >/dev/null 2>&1; then
  BILLING_ACCOUNT=$(gcloud beta billing projects describe "$ACTIVE_PROJECT" --format="value(billingAccount.name)" 2>/dev/null | sed 's|billingAccounts/||' || echo "")
  if [ -n "$BILLING_ACCOUNT" ]; then
    gcloud billing budgets create \
      --billing-account="$BILLING_ACCOUNT" \
      --display-name="FreeField Phase 0 budget" \
      --budget-amount=100USD \
      --threshold-rule=percent=0.5 \
      --threshold-rule=percent=0.9 \
      --threshold-rule=percent=1.0 \
      --notifications-rule=notify_pubsub_topic=projects/"$ACTIVE_PROJECT"/topics/budget-alerts \
      2>&1 || echo "Budget creation failed — configure manually via Cloud Console."
  else
    echo "Could not detect billing account. Configure manually:"
    echo "  → https://console.cloud.google.com/billing/$ACTIVE_PROJECT/budgets"
  fi
else
  echo "gcloud CLI not installed. Configure billing alert manually:"
  echo "  → https://console.cloud.google.com/billing"
fi

# --- 7. Bootstrap first admin ---
echo ""
read -p "Enter first admin email (or Ctrl-C to skip and run later): " ADMIN_EMAIL
if [ -n "$ADMIN_EMAIL" ]; then
  echo "Invoking bootstrapFirstAdmin for $ADMIN_EMAIL..."
  CONTINUE_URL="${CUSTOM_DOMAIN:-https://${ACTIVE_PROJECT}.firebaseapp.com}/finish-sign-in"
  echo "Continue URL: $CONTINUE_URL"
  echo ""
  echo "If bootstrapFirstAdmin is not yet deployed (Phase 0), invoke manually:"
  echo "  firebase functions:shell --project $ACTIVE_PROJECT"
  echo "  > bootstrapFirstAdmin({ email: '$ADMIN_EMAIL', continueUrl: '$CONTINUE_URL' })"
fi

# --- Done ---
echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "1. Set VITE_FIREBASE_* + VITE_EXPECTED_FIREBASE_PROJECT_ID in .env.local"
echo "2. pnpm install"
echo "3. pnpm --filter @free-field/settings build"
echo "4. Deploy your hosting (Firebase Hosting, Vercel, Cloud Run, etc.)"
echo "5. Test sign-in: visit /sign-in, enter admin email, click link"
echo ""
echo "Full deploy guide: docs/deploy/byo-firebase.md (Phase 1)"