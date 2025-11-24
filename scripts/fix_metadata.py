import os
import glob
import pathlib

CONTENT = pathlib.Path("content")

def fix_metadata():
    sub_dirs = [d for d in CONTENT.iterdir() if d.is_dir() and d.name.startswith("r_")]
    
    print(f"[fix] Found {len(sub_dirs)} subreddits. Fixing metadata...")
    
    for sub_dir in sub_dirs:
        name = sub_dir.name
        
        sub_index = sub_dir / "_index.md"
        sub_fm = f"""---
title: "{name}"
sort_by: "date"
transparent: true
template: "section.html"
---
"""
        with open(sub_index, "w", encoding="utf-8") as f:
            f.write(sub_fm)

        archive_file = sub_dir / "archive.md"
        archive_fm = f"""---
title: "{name} Archive"
date: 2099-01-01
template: "archive.html"
extra:
  section_path: "{name}/_index.md"
---
"""
        with open(archive_file, "w", encoding="utf-8") as f:
            f.write(archive_fm)

    print(f"[fix] Metadata fixed for {len(sub_dirs)} subreddits.")

if __name__ == "__main__":
    fix_metadata()
