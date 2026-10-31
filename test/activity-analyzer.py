#!/usr/bin/env python3
"""Private native-fixture adapter: delay owned validation and retain upstream VFS evidence."""
import os
import sys
import time
from pathlib import Path

os.environ['BSL_LOG'] = 'warn,bsl_analyzer::workspace=info'
if len(sys.argv) > 1 and sys.argv[1] == 'lsp':
    os.environ['BSL_LOG_FILE'] = str(Path.cwd() / '.activity-lsp-{pid}.log')
if len(sys.argv) > 1 and sys.argv[1] == 'check-config' and Path('.activity-validation-hold').exists():
    Path('.activity-validation-started').write_text(str(os.getpid()))
    time.sleep(30)
binary = os.environ['ESKA_TEST_ANALYZER_BINARY']
os.execv(binary, [binary, *sys.argv[1:]])
