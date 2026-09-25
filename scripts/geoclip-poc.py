#!/usr/bin/env python3
"""Minimal GeoCLIP sidecar PoC. Use only imagery authorized for analysis."""
from __future__ import annotations
import argparse, json
from pathlib import Path

def main() -> int:
    parser=argparse.ArgumentParser()
    parser.add_argument("image",type=Path)
    parser.add_argument("--top-k",type=int,default=5)
    args=parser.parse_args()
    if not args.image.exists():
        raise SystemExit(f"image not found: {args.image}")
    if args.top_k < 1 or args.top_k > 20:
        raise SystemExit("--top-k must be between 1 and 20")
    try:
        from geoclip import GeoCLIP
    except ImportError as exc:
        raise SystemExit("GeoCLIP is optional. Install with: pip install geoclip") from exc
    model=GeoCLIP()
    gps, probabilities=model.predict(str(args.image),top_k=args.top_k)
    rows=[{"rank":i,"lat":float(c[0]),"lon":float(c[1]),"probability":float(p)} for i,(c,p) in enumerate(zip(gps,probabilities),start=1)]
    print(json.dumps({"model":"GeoCLIP","candidates":rows},ensure_ascii=False))
    return 0

if __name__=="__main__":
    raise SystemExit(main())
