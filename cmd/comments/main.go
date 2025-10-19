package main

import (
	"bufio"
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

type thing struct {
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data"`
}

type wrapListing struct {
	Kind string `json:"kind"`
	Data struct {
		Children []thing `json:"children"`
	} `json:"data"`
}

func must(k string) string {
	v := os.Getenv(k)
	if v == "" {
		fmt.Fprintln(os.Stderr, k+" not set")
		os.Exit(1)
	}
	return v
}

func mustMaybe(k string) string { return os.Getenv(k) }

func httpJSON(method, u, ua, auth string, body io.Reader) (*http.Response, error) {
	req, _ := http.NewRequest(method, u, body)
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Accept", "application/json")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if method == "POST" {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	c := &http.Client{Timeout: 30 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	if !(resp.StatusCode >= 200 && resp.StatusCode < 300) || !strings.Contains(resp.Header.Get("Content-Type"), "application/json") {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		resp.Body.Close()
		return nil, fmt.Errorf("%s %d %s %q", u, resp.StatusCode, resp.Header.Get("Content-Type"), string(b))
	}
	return resp, nil
}

func token(id, secret, ua string) (string, error) {
	user := mustMaybe("REDDIT_USERNAME")
	pass := mustMaybe("REDDIT_PASSWORD")
	var form url.Values
	var auth string
	if user != "" && pass != "" {
		form = url.Values{}
		form.Set("grant_type", "password")
		form.Set("username", user)
		form.Set("password", pass)
		form.Set("scope", "read")
		auth = "Basic " + base64.StdEncoding.EncodeToString([]byte(id+":"+secret))
	} else {
		form = url.Values{}
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

func tsFmtYYMMDDHHMMSS(unix int64) string { return time.Unix(unix, 0).UTC().Format("060102150405") }

func pickRecentPosts(root, sub string, days int) ([]string, error) {
	dir := filepath.Join(root, "r_"+sub, "submissions")
	var cutoff time.Time
	if days > 0 {
		cutoff = time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	} else {
		cutoff = time.Unix(0, 0)
	}
	var ids []string
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, e error) error {
		if e != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		base := filepath.Base(p)
		if len(base) < 16 || !strings.Contains(base, "_") {
			return nil
		}
		ts := base[:12]
		tm, err := time.ParseInLocation("060102150405", ts, time.UTC)
		if err != nil {
			return nil
		}
		if tm.Before(cutoff) {
			return nil
		}
		ids = append(ids, base)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(ids)
	return ids, nil
}

func readPostID(createdID string) (createdKey, postID string) {
	i := strings.Index(createdID, "_")
	if i <= 0 {
		return createdID, ""
	}
	return createdID[:i], createdID[i+1:]
}

func collectInitial(tk, ua, sub, postID string) ([]thing, error) {
	u := fmt.Sprintf("https://oauth.reddit.com/r/%s/comments/%s.json?raw_json=1&limit=500&sort=new", url.PathEscape(sub), url.PathEscape(postID))
	resp, err := httpJSON("GET", u, ua, "Bearer "+tk, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var arr []wrapListing
	if err := json.NewDecoder(resp.Body).Decode(&arr); err != nil {
		return nil, err
	}
	if len(arr) < 2 {
		return nil, fmt.Errorf("bad comments listing")
	}
	out := make([]thing, 0, len(arr[1].Data.Children))
	for _, ch := range arr[1].Data.Children {
		if ch.Kind == "t1" || ch.Kind == "more" {
			out = append(out, ch)
		}
	}
	return out, nil
}

func extractMoreIDs(th []thing) (ids []string) {
	for _, t := range th {
		if t.Kind != "more" {
			continue
		}
		var d map[string]any
		json.Unmarshal(t.Data, &d)
		if ch, ok := d["children"].([]any); ok {
			for _, c := range ch {
				if s, ok := c.(string); ok {
					ids = append(ids, s)
				}
			}
		}
	}
	return
}

func moreChildren(tk, ua, linkFullname string, ids []string) ([]thing, error) {
	form := url.Values{}
	form.Set("api_type", "json")
	form.Set("link_id", linkFullname)
	form.Set("children", strings.Join(ids, ","))
	resp, err := httpJSON("POST", "https://oauth.reddit.com/api/morechildren?raw_json=1", ua, "Bearer "+tk, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var m struct {
		Json struct {
			Data struct {
				Things []thing `json:"things"`
			} `json:"data"`
		} `json:"json"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return nil, err
	}
	out := make([]thing, 0, len(m.Json.Data.Things))
	for _, t := range m.Json.Data.Things {
		if t.Kind == "t1" || t.Kind == "more" {
			out = append(out, t)
		}
	}
	return out, nil
}

type chash struct {
	ID          string `json:"id"`
	ParentID    string `json:"parent_id"`
	LinkID      string `json:"link_id"`
	Author      string `json:"author"`
	Body        string `json:"body"`
	BodyHTML    string `json:"body_html"`
	Edited      any    `json:"edited"`
	Score       any    `json:"score"`
	Collapsed   any    `json:"collapsed"`
	Stickied    any    `json:"stickied"`
	IsSubmitter any    `json:"is_submitter"`
}

func toS(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func subsetHashComments(rows []json.RawMessage) (string, error) {
	var arr []chash
	for _, r := range rows {
		var m map[string]any
		if err := json.Unmarshal(r, &m); err != nil {
			return "", err
		}
		arr = append(arr, chash{
			ID: toS(m["id"]), ParentID: toS(m["parent_id"]), LinkID: toS(m["link_id"]), Author: toS(m["author"]),
			Body: toS(m["body"]), BodyHTML: toS(m["body_html"]), Edited: m["edited"], Score: m["score"], Collapsed: m["collapsed"],
			Stickied: m["stickied"], IsSubmitter: m["is_submitter"],
		})
	}
	sort.Slice(arr, func(i, j int) bool { return arr[i].ID < arr[j].ID })
	b, err := json.Marshal(arr)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func hasHashFile(dir, hash string) (bool, string) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return false, ""
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
		return false, ""
	}
	sort.Strings(cand)
	return true, filepath.Join(dir, cand[len(cand)-1])
}

func latestSubmissionJSON(root, sub, createdID string) (map[string]any, error) {
	dir := filepath.Join(root, "r_"+sub, "submissions", createdID)
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, e := range ents {
		if e.IsDir() {
			continue
		}
		n := e.Name()
		if strings.HasSuffix(n, ".jsonl") {
			files = append(files, n)
		}
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no jsonl")
	}
	sort.Strings(files)
	p := filepath.Join(dir, files[len(files)-1])
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	r := bufio.NewReader(f)
	ln, _, err := r.ReadLine()
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(ln, &m); err != nil {
		return nil, err
	}
	return m, nil
}

func main() {
	var sub string
	var days int
	var root string
	var minComments int
	var force bool
	flag.StringVar(&sub, "sub", "", "subreddit")
	flag.IntVar(&days, "days", 7, "days")
	flag.StringVar(&root, "root", "data/raw", "root")
	flag.IntVar(&minComments, "min-comments", 1, "min comments to fetch")
	flag.BoolVar(&force, "force", false, "force fetch even if num_comments < min-comments")
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
	posts, err := pickRecentPosts(root, sub, days)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	total := 0
	for _, createdID := range posts {
		ck, pid := readPostID(createdID)
		if pid == "" {
			continue
		}
		if !force {
			if m, err := latestSubmissionJSON(root, sub, createdID); err == nil {
				nc := 0
				if v, ok := m["num_comments"]; ok {
					switch t := v.(type) {
					case float64:
						nc = int(t)
					case json.Number:
						if vv, e := t.Int64(); e == nil {
							nc = int(vv)
						}
					}
				}
				if nc < minComments {
					dir := filepath.Join(root, "r_"+sub, "comments", ck+"_"+pid)
					_ = os.MkdirAll(dir, 0o755)
					mark := filepath.Join(dir, time.Now().UTC().Format("060102150405")+"_skip_by_threshold.txt")
					_ = os.WriteFile(mark, []byte(fmt.Sprintf("skipped min-comments=%d nc=%d\n", minComments, nc)), 0o644)
					fmt.Fprintf(os.Stderr, "[%s] %s skip_nocomments nc=%d\n", sub, pid, nc)
					continue
				}
			}
		}
		initThings, err := collectInitial(tk, ua, sub, pid)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			continue
		}
		all := make([]thing, 0, len(initThings))
		for _, t := range initThings {
			if t.Kind == "t1" {
				all = append(all, t)
			}
		}
		mids := extractMoreIDs(initThings)
		link := "t3_" + pid
		for len(mids) > 0 {
			batch := 100
			if len(mids) < batch {
				batch = len(mids)
			}
			cur := mids[:batch]
			mids = mids[batch:]
			more, err := moreChildren(tk, ua, link, cur)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				break
			}
			for _, t := range more {
				if t.Kind == "t1" {
					all = append(all, t)
				}
				if t.Kind == "more" {
					var d map[string]any
					json.Unmarshal(t.Data, &d)
					if ch, ok := d["children"].([]any); ok {
						for _, c := range ch {
							if s, ok := c.(string); ok {
								mids = append(mids, s)
							}
						}
					}
				}
			}
		}
		var rows []json.RawMessage
		for _, t := range all {
			rows = append(rows, t.Data)
		}
		dir := filepath.Join(root, "r_"+sub, "comments", ck+"_"+pid)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fmt.Fprintln(os.Stderr, err)
			continue
		}
		now := time.Now().UTC().Format("060102150405")
		if len(rows) == 0 {
			mark := filepath.Join(dir, now+"_skip_no_comments.txt")
			_ = os.WriteFile(mark, []byte("no comments at capture\n"), 0o644)
			fmt.Fprintf(os.Stderr, "[%s] %s no_comments_marked\n", sub, pid)
			continue
		}
		h, err := subsetHashComments(rows)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			continue
		}
		if ok, _ := hasHashFile(dir, h); ok {
			fmt.Fprintf(os.Stderr, "[%s] %s skip hash=%s\n", sub, pid, h[:8])
			continue
		}
		out := filepath.Join(dir, now+"_"+h+".jsonl")
		f, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o644)
		if err != nil {
			if os.IsExist(err) {
				continue
			}
			fmt.Fprintln(os.Stderr, err)
			continue
		}
		w := bufio.NewWriter(f)
		for _, r := range rows {
			w.Write(r)
			w.WriteByte('\n')
		}
		w.Flush()
		f.Close()
		total++
		fmt.Fprintf(os.Stderr, "[%s] %s wrote=%d hash=%s\n", sub, pid, len(rows), h[:8])
	}
	fmt.Fprintf(os.Stderr, "[%s] done posts=%d\n", sub, total)
}
