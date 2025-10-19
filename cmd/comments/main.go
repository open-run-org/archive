package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func must(k string) string {
	v := os.Getenv(k)
	if v == "" {
		fmt.Fprintln(os.Stderr, k+" not set")
		os.Exit(1)
	}
	return v
}
func maybe(k string) string { return os.Getenv(k) }

func httpJSON(method, u, ua, auth string, body io.Reader) (*http.Response, error) {
	req, _ := http.NewRequest(method, u, body)
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Accept", "application/json")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	c := &http.Client{Timeout: 30 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	if !(resp.StatusCode >= 200 && resp.StatusCode < 300) || !strings.Contains(resp.Header.Get("Content-Type"), "application/json") {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		resp.Body.Close()
		return nil, fmt.Errorf("%s %d %s %q", u, resp.StatusCode, resp.Header.Get("Content-Type"), string(b))
	}
	return resp, nil
}

func token(id, secret, ua string) (string, error) {
	user := maybe("REDDIT_USERNAME")
	pass := maybe("REDDIT_PASSWORD")
	form := url.Values{}
	var auth string
	if user != "" && pass != "" {
		form.Set("grant_type", "password")
		form.Set("username", user)
		form.Set("password", pass)
		form.Set("scope", "read")
		auth = "Basic " + base64.StdEncoding.EncodeToString([]byte(id+":"+secret))
	} else {
		form.Set("grant_type", "client_credentials")
		form.Set("scope", "read")
		auth = "Basic " + base64.StdEncoding.EncodeToString([]byte(id+":"+secret))
	}
	resp, err := httpJSON("POST", "https://www.reddit.com/api/v1/access_token", ua, auth, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var tr struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return "", err
	}
	if tr.AccessToken == "" {
		return "", fmt.Errorf("empty access_token")
	}
	return tr.AccessToken, nil
}

type submissionLite struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Permalink  string  `json:"permalink"`
	CreatedUTC float64 `json:"created_utc"`
	Subreddit  string  `json:"subreddit"`
	Title      string  `json:"title"`
}

func readOneSubmission(path string) (*submissionLite, string, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, "", "", err
	}
	defer f.Close()
	rd := bufio.NewReader(f)
	line, err := rd.ReadBytes('\n')
	if err != nil && err != io.EOF {
		return nil, "", "", err
	}
	var m submissionLite
	if err := json.Unmarshal(bytes.TrimSpace(line), &m); err != nil {
		return nil, "", "", err
	}
	createdID := filepath.Base(filepath.Dir(path))
	capture := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	return &m, createdID, capture, nil
}

func fetchCommentsTree(tk, ua, postID string) ([]map[string]any, error) {
	u := fmt.Sprintf("https://oauth.reddit.com/comments/%s.json?depth=1000&limit=500&raw_json=1&sort=confidence", url.PathEscape(postID))
	resp, err := httpJSON("GET", u, ua, "Bearer "+tk, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var arr []any
	if err := json.NewDecoder(resp.Body).Decode(&arr); err != nil {
		return nil, err
	}
	if len(arr) < 2 {
		return nil, fmt.Errorf("unexpected comments payload")
	}
	root, _ := arr[1].(map[string]any)
	data, _ := root["data"].(map[string]any)
	children, _ := data["children"].([]any)
	var flat []map[string]any
	for _, ch := range children {
		fwalkFlatten(ch, &flat)
	}
	sort.SliceStable(flat, func(i, j int) bool {
		pi := getS(flat[i]["parent_id"])
		pj := getS(flat[j]["parent_id"])
		if pi != pj {
			return pi < pj
		}
		ci := getF(flat[i]["created_utc"])
		cj := getF(flat[j]["created_utc"])
		if ci != cj {
			return ci < cj
		}
		return getS(flat[i]["id"]) < getS(flat[j]["id"])
	})
	return flat, nil
}

func fwalkFlatten(node any, out *[]map[string]any) {
	obj, _ := node.(map[string]any)
	if obj == nil {
		return
	}
	kind, _ := obj["kind"].(string)
	data, _ := obj["data"].(map[string]any)
	if kind == "t1" && data != nil {
		*out = append(*out, data)
		if rep, ok := data["replies"].(map[string]any); ok {
			if rdata, ok := rep["data"].(map[string]any); ok {
				if ch, ok := rdata["children"].([]any); ok {
					for _, c := range ch {
						fwalkFlatten(c, out)
					}
				}
			}
		}
		return
	}
	if kind == "Listing" && data != nil {
		if ch, ok := data["children"].([]any); ok {
			for _, c := range ch {
				fwalkFlatten(c, out)
			}
		}
	}
}

func getS(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
func getF(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case json.Number:
		f, _ := t.Float64()
		return f
	default:
		return 0
	}
}

func threadHash(rows []map[string]any) (string, error) {
	type mini struct {
		ID            string `json:"id"`
		Parent        string `json:"parent_id"`
		Author        string `json:"author"`
		Body          string `json:"body"`
		BodyHTML      string `json:"body_html"`
		Edited        any    `json:"edited"`
		Stickied      bool   `json:"stickied"`
		Distinguished any    `json:"distinguished"`
		IsSubmitter   bool   `json:"is_submitter"`
		Permalink     string `json:"permalink"`
	}
	arr := make([]mini, 0, len(rows))
	for _, r := range rows {
		st := false
		if b, ok := r["stickied"].(bool); ok {
			st = b
		}
		isSub := false
		if b, ok := r["is_submitter"].(bool); ok {
			isSub = b
		}
		arr = append(arr, mini{
			ID:            getS(r["id"]),
			Parent:        getS(r["parent_id"]),
			Author:        getS(r["author"]),
			Body:          getS(r["body"]),
			BodyHTML:      getS(r["body_html"]),
			Edited:        r["edited"],
			Stickied:      st,
			Distinguished: r["distinguished"],
			IsSubmitter:   isSub,
			Permalink:     getS(r["permalink"]),
		})
	}
	b, err := json.Marshal(arr)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func hasHashFile(dir, hash string) (bool, string, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return false, "", nil
		}
		return false, "", err
	}
	var cand []string
	for _, e := range ents {
		if e.IsDir() {
			continue
		}
		n := e.Name()
		if strings.HasSuffix(n, ".jsonl") && strings.Contains(n, "_"+hash) {
			cand = append(cand, n)
		}
	}
	if len(cand) == 0 {
		return false, "", nil
	}
	sort.Strings(cand)
	return true, filepath.Join(dir, cand[len(cand)-1]), nil
}

func main() {
	var sub string
	var days int
	var root string
	flag.StringVar(&sub, "sub", "", "subreddit")
	flag.IntVar(&days, "days", 7, "days")
	flag.StringVar(&root, "root", "data/raw", "root")
	flag.Parse()
	if sub == "" {
		fmt.Fprintln(os.Stderr, "usage: comments -sub <name> [-days N]")
		os.Exit(2)
	}
	ua := must("REDDIT_USER_AGENT")
	tk, err := token(must("REDDIT_CLIENT_ID"), must("REDDIT_CLIENT_SECRET"), ua)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour).Unix()
	subRoot := filepath.Join(root, "r_"+sub, "submissions")
	glob := filepath.Join(subRoot, "*", "*.jsonl")
	matches, _ := filepath.Glob(glob)
	sort.Strings(matches)

	type capInfo struct {
		Path        string
		CreatedUnix int64
		CreatedKey  string
		Capture     string
	}
	byPost := map[string]capInfo{}
	for _, f := range matches {
		sl, createdID, capture, err := readOneSubmission(f)
		if err != nil {
			continue
		}
		created := int64(sl.CreatedUTC)
		if created < cutoff {
			continue
		}
		postID := sl.ID
		old, ok := byPost[postID]
		if !ok || capture > old.Capture {
			byPost[postID] = capInfo{Path: f, CreatedUnix: created, CreatedKey: strings.Split(createdID, "_")[0], Capture: capture}
		}
	}

	keys := make([]string, 0, len(byPost))
	for k := range byPost {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	totalPosts := len(keys)
	writes := 0
	skips := 0
	empties := 0

	fmt.Fprintf(os.Stderr, "[%s] start days=%d posts=%d\n", sub, days, totalPosts)
	for _, pid := range keys {
		info := byPost[pid]
		sl, createdID, _, err := readOneSubmission(info.Path)
		if err != nil {
			continue
		}
		dir := filepath.Join(root, "r_"+sub, "comments", createdID)
		_ = os.MkdirAll(dir, 0o755)

		rows, err := fetchCommentsTree(tk, ua, sl.ID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[%s] %s fetch_error: %v\n", sub, sl.ID, err)
			continue
		}
		if len(rows) == 0 {
			empties++
			_ = os.WriteFile(filepath.Join(dir, "EMPTY.txt"), []byte("no_comments"), 0644)
			fmt.Fprintf(os.Stderr, "[%s] %s no_comments\n", sub, sl.ID)
			continue
		}
		h, err := threadHash(rows)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[%s] %s hash_error: %v\n", sub, sl.ID, err)
			continue
		}
		if ok, _, _ := hasHashFile(dir, h); ok {
			skips++
			fmt.Fprintf(os.Stderr, "[%s] %s skip hash=%s\n", sub, sl.ID, h[:16])
			continue
		}
		nowStr := time.Now().UTC().Format("060102150405")
		out := filepath.Join(dir, nowStr+"_"+h+".jsonl")
		fd, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o644)
		if err != nil {
			if os.IsExist(err) {
				skips++
				fmt.Fprintf(os.Stderr, "[%s] %s skip exists\n", sub, sl.ID)
				continue
			}
			fmt.Fprintln(os.Stderr, err)
			continue
		}
		w := bufio.NewWriter(fd)
		for _, r := range rows {
			b, _ := json.Marshal(r)
			w.Write(b)
			w.WriteByte('\n')
		}
		w.Flush()
		fd.Close()
		writes++
		fmt.Fprintf(os.Stderr, "[%s] %s write %d lines hash=%s\n", sub, sl.ID, len(rows), h[:16])
	}
	fmt.Fprintf(os.Stderr, "[%s] done posts_scanned=%d write=%d skip=%d empty=%d\n", sub, totalPosts, writes, skips, empties)
}
