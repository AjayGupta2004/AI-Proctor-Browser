#!/bin/bash
# Fix better-sqlite3 Node.js version mismatch
# Run this once from the backend directory:
# bash fix-sqlite.sh

echo "→ Using Node: $(node --version)"
echo "→ Rebuilding better-sqlite3 for current Node version..."

npm rebuild better-sqlite3

if [ $? -eq 0 ]; then
  echo "✓ Rebuild successful! You can now run: npm start"
else
  echo "✗ Rebuild failed. Trying fresh install..."
  npm install better-sqlite3 --build-from-source
fi
