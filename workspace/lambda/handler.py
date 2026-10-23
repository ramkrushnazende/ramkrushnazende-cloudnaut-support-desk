"""Lambda entrypoint for the combined public API and backend services."""

import importlib.util
import sys
from pathlib import Path

from mangum import Mangum


ROOT = Path(__file__).resolve().parent
BACKEND_ROOT = ROOT / "backend"
API_ROOT = ROOT / "api"
sys.path.insert(0, str(BACKEND_ROOT))

from app.main import app as backend_app  # noqa: E402

sys.path.insert(0, str(API_ROOT))
from runtime import configure_backend  # noqa: E402

configure_backend(backend_app)

# The backend package is named ``app`` while the public service is ``app.py``.
# Remove the backend package from the import cache before loading the public
# module, otherwise ``from app import app`` resolves to the wrong application.
for module_name in list(sys.modules):
    if module_name == "app" or module_name.startswith("app."):
        del sys.modules[module_name]

api_spec = importlib.util.spec_from_file_location("public_api", API_ROOT / "app.py")
if api_spec is None or api_spec.loader is None:
    raise RuntimeError("Could not load public API application")
public_api = importlib.util.module_from_spec(api_spec)
sys.modules["public_api"] = public_api
api_spec.loader.exec_module(public_api)

handler = Mangum(public_api.app, lifespan="off")