#!/usr/bin/env python3
import json
import os

keys = [k for k in ("WEBSITE_GATE_SKIP_LIGHTHOUSE", "TENWHY_DEV") if k in os.environ]
print(json.dumps([{"check_name": "env", "passed": True, "detail": json.dumps(keys)}]))
