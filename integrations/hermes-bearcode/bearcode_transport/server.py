"""Authenticated aiohttp listener for the BearCode Hermes transport."""
import asyncio
from pathlib import Path

from aiohttp import web

from .connection import (
    BearCodeConnection,
    ConnectionRegistry,
    TurnDelegate,
)
from .ledger import TurnLedger
from .security import AuthRateLimiter, verify_bearer


class BearCodeServer:
    def __init__(
        self,
        host: str,
        port: int,
        platform_key: str,
        delegate: TurnDelegate,
        temp_root: Path,
        state_root: Path,
    ):
        self.host = host
        self.port = port
        self.platform_key = platform_key
        self.delegate = delegate
        self.temp_root = Path(temp_root)
        self.temp_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.temp_root.chmod(0o700)
        self.state_root = Path(state_root)
        self.ledger = TurnLedger(self.state_root)
        self.registry = ConnectionRegistry(self.ledger)
        self.rate_limiter = AuthRateLimiter(
            max_failures=5,
            window_seconds=60,
        )
        self.application = None
        self.runner = None
        self.site = None
        self._connections = set()

    def create_application(self):
        if self.application is not None:
            return self.application
        application = web.Application()
        application.router.add_get(
            "/v1/bearcode",
            self._handle_websocket,
            allow_head=False,
        )
        self.application = application
        return application

    async def _handle_websocket(self, request):
        remote_address = request.remote or "unknown"
        if not self.rate_limiter.allowed(remote_address):
            return web.Response(status=429, text="Too Many Requests")
        if not verify_bearer(
            request.headers.get("Authorization"),
            self.platform_key,
        ):
            self.rate_limiter.record_failure(remote_address)
            return web.Response(status=401, text="Unauthorized")

        websocket = web.WebSocketResponse()
        await websocket.prepare(request)
        connection = BearCodeConnection(
            websocket=websocket,
            registry=self.registry,
            delegate=self.delegate,
            temp_root=self.temp_root,
        )
        self._connections.add(connection)
        try:
            await connection.run()
        finally:
            self._connections.discard(connection)
        return websocket

    async def start(self):
        if self.runner is not None:
            return
        application = self.create_application()
        self.runner = web.AppRunner(application, access_log=None)
        try:
            await self.runner.setup()
            self.site = web.TCPSite(
                self.runner,
                host=self.host,
                port=self.port,
            )
            await self.site.start()
        except Exception:
            runner = self.runner
            self.runner = None
            self.site = None
            await runner.cleanup()
            raise

    async def stop(self):
        connections = list(self._connections)
        if connections:
            await asyncio.gather(
                *(connection.close() for connection in connections),
                return_exceptions=True,
            )
        runner = self.runner
        self.runner = None
        self.site = None
        if runner is not None:
            await runner.cleanup()
