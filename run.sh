#!/bin/bash
# Get the folder directory where this script is placed
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
python3 app.py
