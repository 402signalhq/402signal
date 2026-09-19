"""Offline trust primitives, checked without a hosted-service import."""
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from signal_trust import ORIGIN, checkpoint, jcs, merkle

class PublicVerificationTests(unittest.TestCase):
    def test_inclusion_and_append_only_consistency(self):
        leaves = [merkle.leaf_hash(x) for x in [b"one", b"two", b"three", b"four"]]
        root = merkle.mth_from_leaf_hashes(leaves)
        for index, leaf in enumerate(leaves):
            proof = merkle.inclusion_path(index, leaves)
            self.assertTrue(merkle.verify_inclusion(index, leaf, proof, root, len(leaves)))
            self.assertFalse(merkle.verify_inclusion(index, merkle.leaf_hash(b"changed"), proof, root, len(leaves)))
        for size in [1, 2, 3]:
            old = merkle.mth_from_leaf_hashes(leaves[:size])
            proof = merkle.consistency_path(size, leaves)
            self.assertTrue(merkle.verify_consistency(size, len(leaves), old, root, proof))
            self.assertFalse(merkle.verify_consistency(size, len(leaves), old, bytes(32), proof))

    def test_checkpoint_signature_and_trusted_key(self):
        private = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
        public = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        body = checkpoint.checkpoint_body(ORIGIN, 1, merkle.leaf_hash(b"entry"))
        note = checkpoint.sign_note(body, ORIGIN, private)
        key = checkpoint.vkey_encode(ORIGIN, public)
        self.assertEqual(checkpoint.verify_signed_note(note, key)["body"]["text"], body)
        with self.assertRaises(ValueError):
            checkpoint.verify_signed_note(note.replace("\n1\n", "\n2\n"), key)
        wrong = Ed25519PrivateKey.from_private_bytes(bytes(range(1,33))).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        with self.assertRaises(ValueError):
            checkpoint.verify_signed_note(note, checkpoint.vkey_encode(ORIGIN, wrong))

if __name__ == "__main__":
    unittest.main()
