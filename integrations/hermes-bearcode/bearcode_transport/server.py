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
from .transfers import (
    OutboundSnapshotCleanupOwner,
    VerifiedUploadCleanupOwner,
)


class BearCodeServer:
    def __init__(
        self,
        host: str,
        port: int,
        platform_key: str,
        delegate: TurnDelegate,
        temp_root: Path,
        state_root: Path,
        outbound_roots=None,
    ):
        self.host = host
        self.port = port
        self.platform_key = platform_key
        self.delegate = delegate
        self.temp_root = Path(temp_root)
        self.temp_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.temp_root.chmod(0o700)
        self.state_root = Path(state_root)
        self.outbound_roots = tuple(
            Path(root)
            for root in (
                [self.temp_root]
                if outbound_roots is None
                else outbound_roots
            )
        )
        self.ledger = TurnLedger(self.state_root)
        self.registry = ConnectionRegistry(self.ledger)
        self.snapshot_cleanup_owner = OutboundSnapshotCleanupOwner()
        self.verified_upload_cleanup_owner = VerifiedUploadCleanupOwner()
        self.rate_limiter = AuthRateLimiter(
            max_failures=5,
            window_seconds=60,
        )
        self.application = None
        self.runner = None
        self.site = None
        self._connections = set()
        self._stopping = False
        self._stop_lock = asyncio.Lock()

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
        if self._stopping:
            return web.Response(status=503, text="Service Unavailable")
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
        if self._stopping:
            await websocket.close()
            return websocket
        connection = BearCodeConnection(
            websocket=websocket,
            registry=self.registry,
            delegate=self.delegate,
            temp_root=self.temp_root,
            outbound_roots=self.outbound_roots,
            snapshot_cleanup_owner=self.snapshot_cleanup_owner,
            verified_upload_cleanup_owner=(
                self.verified_upload_cleanup_owner
            ),
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
        self._stopping = False
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
        async with self._stop_lock:
            self._stopping = True
            site = self.site
            self.site = None
            if site is not None:
                await site.stop()
            connections = list(self._connections)
            if connections:
                await asyncio.gather(
                    *(connection.close() for connection in connections),
                    return_exceptions=True,
                )
            runner = self.runner
            self.runner = None
            if runner is not None:
                await runner.cleanup()
            try:
                self.snapshot_cleanup_owner.retry()
            finally:
                self.verified_upload_cleanup_owner.retry()
