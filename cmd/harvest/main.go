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

type tokenResp struct{ AccessToken string }
type child struct{ Data json.RawMessage }
type listing struct {
	Data struct {
		Children []child
		After    string
	}
}

func must(k string) string {
	v := os.Getenv(k)
	if v == "" {
		fmt.Fprintln(os.Stderr, k+" not set")
		os.Exit(1)
	}
	return v
}

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
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("scope", "read")
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte(id+":"+secret))
	resp, err := httpJSON("POST", "https://www.reddit.com/api/v1/access_token", ua, auth, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var tr tokenResp
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return "", err
	}
	return tr.AccessToken, nil
}

func createdIDName(raw json.RawMessage) (int64, string, string, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return 0, "", "", err
	}
	cv, ok := m["created_utc"]
	if !ok {
		return 0, "", "", fmt.Errorf("no created_utc")
	}
	var created int64
	switch t := cv.(type) {
	case float64:
		created = int64(t)
	case json.Number:
		v, err := t.Int64()
		if err != nil {
			return 0, "", "", err
		}
		created = v
	default:
		return 0, "", "", fmt.Errorf("bad created_utc")
	}
	id, _ := m["id"].(string)
	name, _ := m["name"].(string)
	if id == "" || name == "" {
		return 0, "", "", fmt.Errorf("no id/name")
	}
	return created, id, name, nil
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

func main() {
	var sub string
	var days int
	var root string
	var limit int
	flag.StringVar(&sub, "sub", "", "subreddit")
	flag.IntVar(&days, "days", 7, "days")
	flag.StringVar(&root, "root", "data/raw", "root")
	flag.IntVar(&limit, "limit", 100, "limit")
	flag.Parse()
	if sub == "" {
		fmt.Fprintln(os.Stderr, "usage: harvest -sub <name> [-days N]")
		os.Exit(2)
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	ua := must("REDDIT_USER_AGENT")
	tk, err := token(must("REDDIT_CLIENT_ID"), must("REDDIT_CLIENT_SECRET"), ua)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour).Unix()
	after := ""
	wrote := 0
	page := 0
	for {
		page++
		u := fmt.Sprintf("https://oauth.reddit.com/r/%s/new.json?limit=%d&raw_json=1", url.PathEscape(sub), limit)
		if after != "" {
			u += "&after=" + url.QueryEscape(after)
		}
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
		if len(lst.Data.Children) == 0 {
			fmt.Fprintf(os.Stderr, "[%s] %s page=%d empty\n", sub, time.Now().UTC().Format(time.RFC3339), page)
			break
		}
		stop := false
		nextAfter := ""
		nowStr := time.Now().UTC().Format("060102150405")
		batchW := 0
		for _, c := range lst.Data.Children {
			created, id, name, err := createdIDName(c.Data)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			if name != "" {
				nextAfter = name
			}
			if created < cutoff {
				stop = true
				break
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
				continue
			}
			out := filepath.Join(dir, nowStr+"_"+h+".jsonl")
			f, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o644)
			if err != nil {
				if os.IsExist(err) {
					continue
				}
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			w := bufio.NewWriter(f)
			if _, err := w.Write(append(c.Data, '\n')); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			w.Flush()
			f.Close()
			wrote++
			batchW++
		}
		fmt.Fprintf(os.Stderr, "[%s] %s page=%d wrote=%d after=%q stop=%v\n", sub, time.Now().UTC().Format(time.RFC3339), page, batchW, nextAfter, stop)
		if stop || nextAfter == "" {
			break
		}
		after = nextAfter
	}
	fmt.Fprintf(os.Stderr, "[%s] done days=%d total=%d\n", sub, days, wrote)
}
