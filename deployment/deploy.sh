#!/bin/bash
# Kinectro — quick deploy script
# Usage: bash deployment/deploy.sh "optional commit message"

set -e

MSG="${1:-chore: update production}"

echo "▶ Committing changes..."
git add .
git commit -m "$MSG" || echo "Nothing to commit, continuing..."

echo "▶ Pushing to GitHub..."
git push origin main

echo "▶ Deploying to Vercel production..."
vercel --prod --yes

echo ""
echo "✅ Done! Live at https://kinectro.vercel.app"
