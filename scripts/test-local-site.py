import importlib.util
import json
from pathlib import Path
import threading
import unittest
from functools import partial
from io import BytesIO
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("local_site", Path(__file__).with_name("local-site.py"))
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


class LocalSiteTests(unittest.TestCase):
    def setUp(self):
        self.server = local.ThreadingHTTPServer(("127.0.0.1", 0), partial(local.Handler, model="test-model"))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def post(self, payload, origin=None):
        request = Request(self.base + "/api/local-chat", data=json.dumps(payload).encode(),
                          headers={"Content-Type": "application/json", "Origin": origin or self.base})
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_cross_origin_request_is_rejected_before_model_call(self):
        with patch.object(local, "local_open") as model:
            status, _ = self.post({"messages": []}, "https://rabbitsoftware.io")
            self.assertEqual(status, 403)
            model.assert_not_called()

    def test_invalid_messages_do_not_reach_model(self):
        for messages in ([], [{"role": "tool", "content": "x"}], [{"role": "user", "content": ""}]):
            with patch.object(local, "local_open") as model:
                status, _ = self.post({"messages": messages})
                self.assertEqual(status, 400)
                model.assert_not_called()

    def test_only_local_model_is_called_and_output_shape_is_preserved(self):
        response = BytesIO(json.dumps({"message": {"content": "Local answer"}}).encode())
        with patch.object(local, "local_open", return_value=response) as model:
            status, body = self.post({"messages": [{"role": "user", "content": "Public test"}]})
            self.assertEqual(status, 200)
            self.assertEqual(body["choices"][0]["message"]["content"], "Local answer")
            request = model.call_args.args[0]
            self.assertEqual(request.full_url, "http://127.0.0.1:11434/api/chat")
            self.assertEqual(json.loads(request.data)["model"], "test-model")

    def test_model_failure_has_no_hosted_fallback(self):
        with patch.object(local, "local_open", side_effect=URLError("unavailable")) as model:
            status, body = self.post({"messages": [{"role": "user", "content": "Public test"}]})
            self.assertEqual(status, 502)
            self.assertIn("No hosted fallback", body["error"])
            self.assertEqual(model.call_count, 1)

    def test_malformed_model_response_is_an_explicit_failure(self):
        response = BytesIO(b'{"message": "not an object"}')
        with patch.object(local, "local_open", return_value=response):
            status, body = self.post({"messages": [{"role": "user", "content": "Public test"}]})
            self.assertEqual(status, 502)
            self.assertIn("No hosted fallback", body["error"])

    def test_model_redirects_are_refused(self):
        with self.assertRaises(URLError):
            local.NoRedirects().redirect_request(None, None, 302, "", {},
                                                "https://example.com")

    def test_static_homepage_remains_available(self):
        with urlopen(self.base + "/") as response:
            self.assertEqual(response.status, 200)
            self.assertIn(b"RabbitSoftware", response.read())


if __name__ == "__main__":
    unittest.main()
