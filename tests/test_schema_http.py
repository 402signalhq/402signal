"""HTTP profile schema contracts. No payment, signing or network calls."""
from copy import deepcopy
import json
import re
import unittest
from live402 import schema_fields, schema_http, mcp, probe_profile
from live402.batch_profiles import base, solana, algorand_generic


class HttpSchemaTests(unittest.TestCase):
    def test_http_profiles_are_closed_and_disjoint(self):
        schema = schema_fields.route_body_schema()
        self.assertFalse(schema['additionalProperties'])
        self.assertEqual(len(schema['oneOf']), 5)
        for variant in schema['oneOf']:
            self.assertFalse(variant['additionalProperties'])
        for name in ('probe_request', 'merchant_profile', 'buyer_limits'):
            self.assertIn(name, schema['properties'])
        self.assertEqual(schema['anyOf'], list(schema_fields.NEED_OR_URL_ANYOF))

    def test_mcp_keeps_the_existing_advertised_input(self):
        schema = schema_fields.route_body_schema(surface='mcp')
        self.assertEqual(mcp.INPUT_SCHEMA, schema)
        self.assertNotIn('oneOf', schema)
        for name in ('probe_request', 'merchant_profile', 'buyer_limits'):
            self.assertNotIn(name, schema['properties'])
        with self.assertRaises(ValueError):
            schema_fields.route_body_schema(surface='unknown')

    def test_schema_assembly_does_not_mutate_other_surfaces(self):
        before = deepcopy(mcp.INPUT_SCHEMA)
        http = schema_fields.route_body_schema()
        http['properties']['networks']['items']['enum'].append('not-a-chain')
        self.assertEqual(mcp.INPUT_SCHEMA, before)
        self.assertNotIn('not-a-chain', schema_fields.route_body_schema()['properties']['networks']['items']['enum'])

    def test_batch_limit_keys_match_authoritative_parsers(self):
        limits = schema_http.batch_limit_schemas()
        for profile, module in [('base-x402-batch-v1', base), ('solana-mpp-session-v1', solana), ('algorand-atomic-two-item-v1', algorand_generic)]:
            with self.subTest(profile=profile):
                item = limits[profile]
                self.assertFalse(item['additionalProperties'])
                self.assertEqual(set(item['required']), module.KEYS)
                self.assertEqual(set(item['properties']), module.KEYS)
                self.assertEqual(item['properties']['network']['const'], module.NETWORK)
                self.assertEqual(item['properties']['asset']['const'], module.ASSET)

    def test_uint64_strings_do_not_coerce_or_overflow(self):
        pattern = re.compile(schema_http.uint64_pattern())
        for value in ('1', '9', '10', '1000', '9999999999999999999', str(2**64-1)):
            self.assertIsNotNone(pattern.fullmatch(value), value)
        for value in ('0', '-1', '+1', '01', '1.0', '1e3', ' 1', '1 ', str(2**64), '9'*20, '1'*21):
            self.assertIsNone(pattern.fullmatch(value), value)

    def test_post_profile_cannot_be_discovery_or_an_arbitrary_proxy(self):
        search = schema_fields.route_body_schema()['oneOf'][1]
        self.assertNotIn('need', search['properties'])
        self.assertEqual(search['properties']['url']['const'], probe_profile.URL)
        self.assertIs(search['properties']['require_route_binding']['const'], True)
        post = search['properties']['probe_request']
        self.assertEqual(set(post['required']), {'profile', 'method', 'body'})
        self.assertFalse(post['additionalProperties'])
        self.assertEqual(post['properties']['profile']['const'], probe_profile.PROFILE)
        self.assertEqual(post['properties']['method']['const'], 'POST')
        body_schema = post['properties']['body']
        self.assertEqual(body_schema['maxLength'], probe_profile.MAX_BYTES)
        self.assertEqual(body_schema['contentMediaType'], 'application/json')
        self.assertIn('not enforced by every validator', body_schema['description'])

    def test_runtime_body_checks_remain_authoritative(self):
        request = {'url': probe_profile.URL, 'require_route_binding': True, 'probe_request': {
            'profile': probe_profile.PROFILE, 'method': 'POST',
            'body': json.dumps({'query': 'weather', 'mode': 'one-shot'})}}
        self.assertIsNotNone(probe_profile.parse(request))
        for body in ('{"query":"a","query":"b","mode":"one-shot"}',
                     '{"query":" ","mode":"one-shot"}',
                     json.dumps({'query': 'a'*301, 'mode': 'one-shot'})):
            altered = deepcopy(request)
            altered['probe_request']['body'] = body
            with self.assertRaises(probe_profile.ProfileError):
                probe_profile.parse(altered)


if __name__ == '__main__':
    unittest.main()
