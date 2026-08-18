# Starter for the "python" runtime — edit before deploying.
# `app` is an ASGI application, so FastAPI/Starlette/etc. work too — just
# assign your app to `app`. The runtime serves it on the ingress port.
async def app(scope, receive, send):
    if scope["type"] != "http":
        return
    await send({
        "type": "http.response.start",
        "status": 200,
        "headers": [(b"content-type", b"text/plain")],
    })
    await send({"type": "http.response.body", "body": b"hello from supabase workers\n"})
