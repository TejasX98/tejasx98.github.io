#!/bin/bash
# Double-click to open the portfolio admin (Mac). Linux: run  ./start-admin.command
cd "$(dirname "$0")"
python3 -c "import yaml, PIL" 2>/dev/null || python3 -m pip install --user -r admin/requirements.txt
python3 admin/admin.py
