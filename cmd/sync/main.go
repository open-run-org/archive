package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"
)

type tokenResp struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
	Scope       string `json:"scope"`
}

type thing struct {
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data"`
}

type listing struct {
	Kind string `json:"kind"`
	Data struct {
		Children []thing `json:"children"`
		After    string  `json:"after"`
		Before   string  `json:"before"`
		Dist     int     `json:"dist"`
	} `json:"data"`
}

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		fmt.Fprintf(os.Stderr, "%s not set\n", k)
		os.Exit(1)
	}
	return v
}

func getToken(clientID, clientSecret, userAgent string) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	req, err := http.NewRequest("POST", "https://www.reddit.com/api/v1/access_token", bytes.NewBufferString(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(clientID+":"+clientSecret)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("token status %d: %s", resp.StatusCode, string(b))
	}
	var tr tokenResp
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return "", err
	}
	return tr.AccessToken, nil
}

func fetchNew(sub, token, userAgent, after string, limit int) (*listing, error) {
	u := fmt.Sprintf("https://oauth.reddit.com/r/%s/new?limit=%d", url.PathEscape(sub), limit)
	if after != "" {
		u += "&after=" + url.QueryEscape(after)
	}
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("list status %d: %s", resp.StatusCode, string(b))
	}
	var lst listing
	if err := json.NewDecoder(resp.Body).Decode(&lst); err != nil {
		return nil, err
	}
	return &lst, nil
}

func extractCreatedUTC(raw json.RawMessage) (float64, string, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return 0, "", err
	}
	cv, ok := m["created_utc"]
	if !ok {
		return 0, "", fmt.Errorf("no created_utc")
	}
	var created float64
	switch t := cv.(type) {
	case float64:
		created = t
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return 0, "", err
		}
		created = f
	default:
		return 0, "", fmt.Errorf("bad created_utc type")
	}
	id := ""
	if v, ok := m["name"]; ok {
		if s, ok := v.(string); ok {
			id = s
		}
	}
	return created, id, nil
}

func main() {
	var sub string
	var out string
	var limit int
	var sinceDays int
	var max int
	flag.StringVar(&sub, "sub", "", "subreddit")
	flag.StringVar(&out, "out", "", "output jsonl path")
	flag.IntVar(&limit, "limit", 100, "page size")
	flag.IntVar(&sinceDays, "since-days", 365, "days window")
	flag.IntVar(&max, "max", 0, "max posts, 0=unlimited")
	flag.Parse()
	if sub == "" || out == "" {
		fmt.Fprintln(os.Stderr, "usage: sync -sub <name> -out <jsonl> [-limit 100] [-since-days 365] [-max 0]")
		os.Exit(2)
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	clientID := mustEnv("REDDIT_CLIENT_ID")
	clientSecret := mustEnv("REDDIT_CLIENT_SECRET")
	userAgent := mustEnv("REDDIT_USER_AGENT")
	token, err := getToken(clientID, clientSecret, userAgent)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	cutoff := time.Now().Add(-time.Duration(sinceDays) * 24 * time.Hour).Unix()
	f, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	defer w.Flush()
	after := ""
	total := 0
	for {
		lst, err := fetchNew(sub, token, userAgent, after, limit)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if len(lst.Data.Children) == 0 {
			break
		}
		var lastName string
		var wrote int
		for _, t := range lst.Data.Children {
			created, name, err := extractCreatedUTC(t.Data)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			if created < float64(cutoff) {
				after = ""
				break
			}
			b := append(t.Data, '\n')
			if _, err := w.Write(b); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			total++
			wrote++
			lastName = name
			if max > 0 && total >= max {
				after = ""
				break
			}
		}
		if max > 0 && total >= max {
			break
		}
		if wrote == 0 {
			break
		}
		if lastName == "" {
			break
		}
		after = lastName
	}
	fmt.Fprintf(os.Stderr, "synced %s posts: %d since %s\n", sub, total, time.Unix(cutoff, 0).UTC().Format(time.RFC3339))
}
