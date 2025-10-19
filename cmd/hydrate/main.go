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
	form := url.Values{}
	form.Set("scope", "read")
	var auth string
	if user != "" && pass != "" {
		form.Set("grant_type", "password")
		form.Set("username", user)
		form.Set("password", pass)
	} else {
		form.Set("grant_type", "client_credentials")
	}
	auth = "Basic " + base64.StdEncoding.EncodeToString([]byte(id+":"+secret))
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

func getS(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
func getB(v any) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return false
}

type fp struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Subreddit         string `json:"subreddit"`
	Author            string `json:"author"`
	IsSelf            bool   `json:"is_self"`
	Domain            string `json:"domain"`
	Title             string `json:"title"`
	SelftextHTML      string `json:"selftext_html"`
	Selftext          string `json:"selftext"`
	URL               string `json:"url"`
	Permalink         string `json:"permalink"`
	Edited            any    `json:"edited"`
	Over18            bool   `json:"over_18"`
	Spoiler           bool   `json:"spoiler"`
	Locked            bool   `json:"locked"`
	Stickied          bool   `json:"stickied"`
	LinkFlairText     string `json:"link_flair_text"`
	LinkFlairCSSClass string `json:"link_flair_css_class"`
}

func subsetHash(raw json.RawMessage) (string, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", err
	}
	g := fp{
		ID: getS(m["id"]), Name: getS(m["name"]), Subreddit: getS(m["subreddit"]), Author: getS(m["author"]),
		IsSelf: getB(m["is_self"]), Domain: getS(m["domain"]),
		Title: getS(m["title"]), SelftextHTML: getS(m["selftext_html"]), Selftext: getS(m["selftext"]),
		URL: getS(m["url"]), Permalink: getS(m["permalink"]), Edited: m["edited"],
		Over18: getB(m["over_18"]), Spoiler: getB(m["spoiler"]), Locked: getB(m["locked"]), Stickied: getB(m["stickied"]),
		LinkFlairText: getS(m["link_flair_text"]), LinkFlairCSSClass: getS(m["link_flair_css_class"]),
	}
	b, err := json.Marshal(g)
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

func tsFmtYYMMDDHHMMSS(unix int64) string { return time.Unix(unix, 0).UTC().Format("060102150405") }

type child struct{ Data json.RawMessage }
type listing struct{ Data struct{ Children []child } }

func main() {
	var sub string
	var inPath string
	var root string
	var batch int
	flag.StringVar(&sub, "sub", "", "subreddit")
	flag.StringVar(&inPath, "in", "", "ids file")
	flag.StringVar(&root, "root", "data/raw", "root")
	flag.IntVar(&batch, "batch", 100, "batch size")
	flag.Parse()
	if sub == "" || inPath == "" {
		fmt.Fprintln(os.Stderr, "usage: hydrate -sub <name> -in <ids.txt>")
		os.Exit(2)
	}
	if batch <= 0 || batch > 100 {
		batch = 100
	}
	ua := must("REDDIT_USER_AGENT")
	tk, err := token(must("REDDIT_CLIENT_ID"), must("REDDIT_CLIENT_SECRET"), ua)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	f, err := os.Open(inPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer f.Close()
	type rec struct {
		ID      string
		Created int64
	}
	var buf []rec
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		l := sc.Text()
		parts := strings.Split(l, "\t")
		if len(parts) < 2 {
			continue
		}
		id := strings.TrimSpace(parts[0])
		created := strings.TrimSpace(parts[1])
		if id == "" || created == "" {
			continue
		}
		var cu int64
		fmt.Sscan(created, &cu)
		buf = append(buf, rec{ID: id, Created: cu})
	}
	if err := sc.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	total := 0
	for i := 0; i < len(buf); i += batch {
		j := i + batch
		if j > len(buf) {
			j = len(buf)
		}
		chunk := buf[i:j]
		var ids []string
		for _, r := range chunk {
			ids = append(ids, "t3_"+r.ID)
		}
		u := "https://oauth.reddit.com/api/info?id=" + url.QueryEscape(strings.Join(ids, ","))
		resp, err := httpJSON("GET", u, ua, "Bearer "+tk, nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		var lst listing
		if err := json.NewDecoder(resp.Body).Decode(&lst); err != nil {
			resp.Body.Close()
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		resp.Body.Close()
		wrote := 0
		nowStr := time.Now().UTC().Format("060102150405")
		for _, c := range lst.Data.Children {
			var m map[string]any
			if err := json.Unmarshal(c.Data, &m); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			sr := strings.ToLower(fmt.Sprint(m["subreddit"]))
			if sr != strings.ToLower(sub) {
				continue
			}
			id, _ := m["id"].(string)
			name, _ := m["name"].(string)
			cv := m["created_utc"]
			var created int64
			switch t := cv.(type) {
			case float64:
				created = int64(t)
			case json.Number:
				v, _ := t.Int64()
				created = v
			}
			if id == "" || name == "" || created <= 0 {
				continue
			}
			dir := filepath.Join(root, "r_"+sub, "submissions", tsFmtYYMMDDHHMMSS(created)+"_"+id)
			if err := os.MkdirAll(dir, 0o755); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			h, err := subsetHash(c.Data)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			if ok, _, _ := hasHashFile(dir, h); ok {
				fmt.Fprintf(os.Stderr, "[%s] skip %s\n", sub, id)
				continue
			}
			out := filepath.Join(dir, nowStr+"_"+h+".jsonl")
			g, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o644)
			if err != nil {
				if os.IsExist(err) {
					fmt.Fprintf(os.Stderr, "[%s] skip %s\n", sub, id)
					continue
				}
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			w := bufio.NewWriter(g)
			if _, err := w.Write(append(c.Data, '\n')); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			w.Flush()
			g.Close()
			wrote++
		}
		total += wrote
		fmt.Fprintf(os.Stderr, "[%s] hydrate chunk=%d wrote=%d\n", sub, len(chunk), wrote)
	}
	fmt.Fprintf(os.Stderr, "[%s] hydrate done total=%d\n", sub, total)
}
