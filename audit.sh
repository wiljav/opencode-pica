#!/bin/bash

# Default to current directory if no argument is provided
TARGET="${1:-.}"

# Function to scan extracted files
scan_files() {
    local pkg_name="$1"
    local search_dir="$2"
    
    echo -e "\n=================================================="
    echo "AUDIT RESULTS: $pkg_name"
    echo "=================================================="
    
    echo "[1] External URLs:"
    grep -rEho 'https?://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^"'\''`[:space:]]*' "$search_dir" --include="*.js" --include="*.ts" --include="*.py" --exclude-dir={node_modules,.git,dist} 2>/dev/null \
        | grep -v "localhost" | grep -v "127.0.0.1" | sort -u | head -n 10 || echo "  [OK] None found."
        
    echo "[2] Network Calls:"
    grep -rEh 'fetch\(|axios\.|requests\.(get|post)|urllib' "$search_dir" --include="*.js" --include="*.ts" --include="*.py" --exclude-dir={node_modules,.git,dist} 2>/dev/null | head -n 10 || echo "  [OK] None found."
    
    echo "[3] File System Access:"
    grep -rEh 'fs\.(readFile|writeFile|unlink)|open\(|path\.(join|resolve)' "$search_dir" --include="*.js" --include="*.ts" --include="*.py" --exclude-dir={node_modules,.git,dist} 2>/dev/null | head -n 10 || echo "  [OK] None found."

    echo "[4] Insecure TLS/SSL Flags:"
    grep -rEi 'rejectUnauthorized:[[:space:]]*false|TrustServerCertificate=yes|NODE_TLS_REJECT_UNAUTHORIZED' "$search_dir" --include="*.js" --include="*.ts" --include="*.py" --exclude-dir={node_modules,.git,dist} 2>/dev/null | head -n 10 || echo "  [OK] None found."
}

# --- MODE 1: LOCAL DIRECTORY SCAN ---
if [ -d "$TARGET" ]; then
    echo ">>> Scanning local directory: $TARGET"
    scan_files "Local Scan ($TARGET)" "$TARGET"
    exit 0
fi

# --- MODE 2: CATALOG SCAN ---
if [ -f "$TARGET" ]; then
    CATALOG="$TARGET"
    echo ">>> Scanning catalog: $CATALOG"
    
    if ! command -v jq &> /dev/null; then
        echo "Error: jq is required for catalog scanning."
        exit 1
    fi

    TMP_DIR=$(mktemp -d)
    trap 'echo -e "\n[INFO] Cleaning up temporary files..."; rm -rf "$TMP_DIR"' EXIT
    
    # 1. AUDIT NPM PLUGINS
    while IFS=$'\t' read -r PKG VER; do
        PKG_DIR="$TMP_DIR/npm_$PKG"
        mkdir -p "$PKG_DIR"
        echo "Downloading $PKG@$VER..."
        (cd "$PKG_DIR" && npm pack "$PKG@$VER" >/dev/null 2>&1 && tar -xzf *.tgz >/dev/null 2>&1)
        if [ -d "$PKG_DIR/package" ]; then
            scan_files "$PKG@$VER" "$PKG_DIR/package"
        else
            echo -e "\n[ERROR] Failed to extract $PKG@$VER"
        fi
    done < <(jq -r '.plugins[]? | select(.kind=="npm") | [.package, .version] | @tsv' "$CATALOG")

    # 2. AUDIT PYPI MCPS
    while IFS=$'\t' read -r PKG VER; do
        PKG_DIR="$TMP_DIR/pypi_$PKG"
        mkdir -p "$PKG_DIR"
        echo "Downloading $PKG==$VER..."
        pip download "$PKG==$VER" --no-deps -d "$PKG_DIR" -q >/dev/null 2>&1
        for file in "$PKG_DIR"/*; do
            if [[ "$file" == *.whl ]] || [[ "$file" == *.zip ]]; then
                unzip -q "$file" -d "$PKG_DIR/extracted" >/dev/null 2>&1
            elif [[ "$file" == *.tar.gz ]]; then
                mkdir -p "$PKG_DIR/extracted"
                tar -xzf "$file" -C "$PKG_DIR/extracted" >/dev/null 2>&1
            fi
        done
        if [ -d "$PKG_DIR/extracted" ]; then
            scan_files "$PKG==$VER" "$PKG_DIR/extracted"
        fi
    done < <(jq -r '.mcps[]? | select(.command | index("uvx")) | [.package, .version] | @tsv' "$CATALOG")
    
    exit 0
fi

echo "Error: '$TARGET' is neither a directory nor a file."
exit 1
