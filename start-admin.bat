@echo off
REM Double-click to open the portfolio admin (Windows)
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py) || (set PY=python)
%PY% -c "import yaml, PIL" 2>nul || %PY% -m pip install --user -r admin\requirements.txt
%PY% admin\admin.py
pause
