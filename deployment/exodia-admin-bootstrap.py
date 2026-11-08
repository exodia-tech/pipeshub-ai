import json, os, pathlib, time, urllib.request, urllib.error
origin = 'http://127.0.0.1:3000'
def request(path, data=None, session=None):
    headers = {'Content-Type': 'application/json'}
    if session: headers['x-session-token'] = session
    req = urllib.request.Request(origin + path, headers=headers, data=json.dumps(data).encode() if data is not None else None)
    with urllib.request.urlopen(req, timeout=20) as response:
        body = json.load(response)
        return body, response.headers
initial_setup = False
for attempt in range(120):
    try:
        status, _ = request('/api/v1/org/exists')
        exists = status.get('exists')
        if exists is True and not initial_setup:
            pathlib.Path('/tmp/exodia-admin-ready').touch()
            print('Existing EXODIA organization ready', flush=True)
            break
        if exists is not True and exists is not False:
            raise RuntimeError('Organization state unavailable')
        email = os.environ['EXODIA_ADMIN_EMAIL']
        password = os.environ['EXODIA_ADMIN_PASSWORD']
        if exists is False:
            initial_setup = True
            request('/api/v1/org', {'accountType':'business','contactEmail':email,'adminFullName':'EXODIA Administrator','password':password,'registeredName':'EXODIA'})
        _, headers = request('/api/v1/userAccount/initAuth', {'email':email})
        session = headers.get('x-session-token')
        if not session: raise RuntimeError('missing session')
        auth, _ = request('/api/v1/userAccount/authenticate', {'method':'password','email':email,'credentials':{'password':password}}, session)
        if not auth.get('accessToken'): raise RuntimeError('login failed')
        pathlib.Path('/tmp/exodia-admin-ready').touch()
        print('EXODIA admin initialized and password login verified', flush=True)
        break
    except Exception:
        time.sleep(10)
else:
    print('EXODIA admin initialization failed; public readiness remains blocked', flush=True)
