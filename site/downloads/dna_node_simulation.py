#!/usr/bin/env python3
"""DNA/RNA-inspired software simulation. No biology, RF, or hardware control.

Run: python dna_node_simulation.py
Python 3.10+ syntax; standard library only. State is in memory, not persistent.
This replaces the supplied prototype's biological operation names with explicit
virtual operations. It is not API-compatible with that prototype.
"""

from dataclasses import asdict, dataclass, replace
from enum import Enum
import hashlib
import json
import math
import re


MAX_BYTES = 65_536
MAX_BASES = MAX_BYTES * 4
BASES = "ACGT"
RNA_COMPLEMENT = str.maketrans("ACGU", "UGCA")
CODON_TABLE = {
    "UUU": "Phe", "UUC": "Phe", "UUA": "Leu", "UUG": "Leu",
    "CUU": "Leu", "CUC": "Leu", "CUA": "Leu", "CUG": "Leu",
    "AUU": "Ile", "AUC": "Ile", "AUA": "Ile", "AUG": "Met",
    "GUU": "Val", "GUC": "Val", "GUA": "Val", "GUG": "Val",
    "UCU": "Ser", "UCC": "Ser", "UCA": "Ser", "UCG": "Ser",
    "CCU": "Pro", "CCC": "Pro", "CCA": "Pro", "CCG": "Pro",
    "ACU": "Thr", "ACC": "Thr", "ACA": "Thr", "ACG": "Thr",
    "GCU": "Ala", "GCC": "Ala", "GCA": "Ala", "GCG": "Ala",
    "UAU": "Tyr", "UAC": "Tyr", "UAA": "Stop", "UAG": "Stop",
    "CAU": "His", "CAC": "His", "CAA": "Gln", "CAG": "Gln",
    "AAU": "Asn", "AAC": "Asn", "AAA": "Lys", "AAG": "Lys",
    "GAU": "Asp", "GAC": "Asp", "GAA": "Glu", "GAG": "Glu",
    "UGU": "Cys", "UGC": "Cys", "UGA": "Stop", "UGG": "Trp",
    "CGU": "Arg", "CGC": "Arg", "CGA": "Arg", "CGG": "Arg",
    "AGU": "Ser", "AGC": "Ser", "AGA": "Arg", "AGG": "Arg",
    "GGU": "Gly", "GGC": "Gly", "GGA": "Gly", "GGG": "Gly",
}


def normalize(sequence: str, alphabet: str, *, allow_empty: bool = False) -> str:
    if len(sequence) > MAX_BASES:
        raise ValueError(f"Sequence exceeds {MAX_BASES} characters.")
    result = sequence.upper()
    if not result and not allow_empty:
        raise ValueError("Sequence must not be empty.")
    if any(base not in alphabet for base in result):
        raise ValueError(f"Sequence must contain only {alphabet}; no whitespace.")
    return result


@dataclass(frozen=True)
class SequenceLabel:
    sequence: str
    sha3_256: str
    mean_symbol_value: float
    simulation_only: bool = True


class SequenceMapper:
    """Symbol scores are arbitrary and unitless, not physical frequencies."""

    @staticmethod
    def describe_dna(sequence: str) -> SequenceLabel:
        dna = normalize(sequence, BASES)
        return SequenceLabel(
            sequence=dna,
            sha3_256=hashlib.sha3_256(dna.encode("ascii")).hexdigest(),
            mean_symbol_value=sum(BASES.index(base) for base in dna) / len(dna),
        )

    @staticmethod
    def transcribe(dna: str) -> str:
        """Treat input as a coding-strand string written 5' to 3'."""
        return normalize(dna, BASES).replace("T", "U")

    @staticmethod
    def translate(mrna: str) -> tuple[str, ...]:
        """Read from offset zero, stop at the first stop codon; no ORF search."""
        rna = normalize(mrna, "ACGU")
        if len(rna) % 3:
            raise ValueError("Translation requires complete three-base codons.")
        amino_acids: list[str] = []
        for offset in range(0, len(rna), 3):
            amino_acid = CODON_TABLE[rna[offset:offset + 3]]
            if amino_acid == "Stop":
                break
            amino_acids.append(amino_acid)
        return tuple(amino_acids)

    @staticmethod
    def amino_acid_for_anticodon(anticodon_3_to_5: str) -> str:
        """Exact complement only; input is 3' to 5', output codon is 5' to 3'."""
        anticodon = normalize(anticodon_3_to_5, "ACGU")
        if len(anticodon) != 3:
            raise ValueError("An anticodon must contain exactly three bases.")
        amino_acid = CODON_TABLE[anticodon.translate(RNA_COMPLEMENT)]
        if amino_acid == "Stop":
            raise ValueError("A stop codon has no amino acid in this model.")
        return amino_acid


class DNADataStorage:
    """Reversible string encoding: four characters per byte, not molecular storage."""

    @staticmethod
    def encode_data_to_dna(data: bytes) -> str:
        if len(data) > MAX_BYTES:
            raise ValueError(f"Payload exceeds {MAX_BYTES} bytes.")
        return "".join(BASES[(byte >> shift) & 3]
                       for byte in data for shift in (6, 4, 2, 0))

    @staticmethod
    def decode_dna_to_data(sequence: str) -> bytes:
        dna = normalize(sequence, BASES, allow_empty=True)
        if len(dna) % 4:
            raise ValueError("Encoded data requires four bases per byte.")
        return bytes(
            sum(BASES.index(dna[offset + index]) << (6 - 2 * index)
                for index in range(4))
            for offset in range(0, len(dna), 4)
        )


class Operation(str, Enum):
    ACTIVATE = "activate"
    DEACTIVATE = "deactivate"
    SILENCE = "silence"
    UNSILENCE = "unsilence"


@dataclass(frozen=True)
class VirtualNode:
    node_id: str
    label: SequenceLabel
    active: bool = True
    silenced: bool = False
    sensitivity: float = 0.5
    simulation_only: bool = True


@dataclass(frozen=True)
class StorageRecord:
    node_id: str
    encoded_data: str
    payload_sha3_256: str
    byte_count: int
    simulation_only: bool = True


class VirtualNodeInterface:
    def __init__(self) -> None:
        self._nodes: dict[str, VirtualNode] = {}
        self._records: dict[str, StorageRecord] = {}

    def register(self, node_id: str, dna: str) -> VirtualNode:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", node_id):
            raise ValueError("Node ID must be 1-64 ASCII letters, digits, _ or -.")
        if node_id in self._nodes:
            raise ValueError(f"Node already registered: {node_id}")
        node = VirtualNode(node_id, SequenceMapper.describe_dna(dna))
        self._nodes[node_id] = node
        return node

    def status(self, node_id: str) -> VirtualNode:
        if node_id not in self._nodes:
            raise ValueError(f"Unknown virtual node: {node_id}")
        return self._nodes[node_id]

    def apply(self, node_id: str, operation: str) -> VirtualNode:
        node = self.status(node_id)
        action = Operation(operation)
        if action == Operation.ACTIVATE:
            updated = replace(node, active=True)
        elif action == Operation.DEACTIVATE:
            updated = replace(node, active=False)
        elif action == Operation.SILENCE:
            updated = replace(node, silenced=True)
        else:
            updated = replace(node, silenced=False)
        self._nodes[node_id] = updated
        return updated

    def set_sensitivity(self, node_id: str, value: float) -> VirtualNode:
        node = self.status(node_id)
        if not math.isfinite(value) or not 0.0 <= value <= 1.0:
            raise ValueError("Sensitivity must be finite and between 0 and 1.")
        updated = replace(node, sensitivity=value)
        self._nodes[node_id] = updated
        return updated

    def store(self, node_id: str, data: bytes) -> StorageRecord:
        self.status(node_id)
        record = StorageRecord(
            node_id, DNADataStorage.encode_data_to_dna(data),
            hashlib.sha3_256(data).hexdigest(), len(data),
        )
        self._records[node_id] = record
        return record

    def retrieve(self, node_id: str) -> bytes:
        self.status(node_id)
        if node_id not in self._records:
            raise ValueError(f"No stored data for virtual node: {node_id}")
        record = self._records[node_id]
        data = DNADataStorage.decode_dna_to_data(record.encoded_data)
        if (len(data) != record.byte_count
                or hashlib.sha3_256(data).hexdigest() != record.payload_sha3_256):
            raise ValueError("Stored data failed its integrity check.")
        return data


def complete_demonstration() -> None:
    interface = VirtualNodeInterface()
    interface.register("DEMO_01", "ATGGCTTAA")
    mrna = SequenceMapper.transcribe("ATGGCTTAA")
    interface.apply("DEMO_01", "silence")
    interface.set_sensitivity("DEMO_01", 0.75)
    payload = b"Software-only demonstration"
    record = interface.store("DEMO_01", payload)
    restored = interface.retrieve("DEMO_01")
    if restored != payload:
        raise RuntimeError("Demonstration payload did not round-trip.")
    print(json.dumps({
        "scope": "Software simulation only; no biological or hardware effects.",
        "node": asdict(interface.status("DEMO_01")),
        "translation": SequenceMapper.translate(mrna),
        "anticodon_3_to_5": "UAC",
        "anticodon_amino_acid": SequenceMapper.amino_acid_for_anticodon("UAC"),
        "storage": asdict(record),
        "restored_text": restored.decode("ascii"),
        "round_trip_verified": True,
    }, indent=2, allow_nan=False))


if __name__ == "__main__":
    complete_demonstration()
