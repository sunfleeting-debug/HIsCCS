package com.bluecome.cmg.services

/**
 * BM25-based retrieval service for finding similar historical commits.
 * Used to augment the prompt with contextually relevant commit examples.
 */
object RetrievalService {

    /** Simple tokenizer: lowercase, split on non-alphanum, filter short words */
    private fun tokenize(text: String): List<String> {
        return text.lowercase()
            .split(Regex("[^a-z0-9\\u4e00-\\u9fff]+"))
            .filter { it.length > 1 }
    }

    /** BM25 scoring of a single doc against query terms */
    private fun scoreDoc(queryTerms: List<String>, docTokens: List<String>, avgdl: Double): Double {
        if (queryTerms.isEmpty() || docTokens.isEmpty()) return 0.0
        val K1 = 1.2
        val B = 0.75
        val docLen = docTokens.size.toDouble()
        val tfMap = docTokens.groupingBy { it }.eachCount()
        var score = 0.0
        for (q in queryTerms) {
            val tf = tfMap[q] ?: 0
            val idf = Math.log(1.0 + (1.0 + tf) / (1.0 + tf)) // simplified IDF
            val dfFactor = (K1 + 1.0) * tf / (K1 * (1.0 - B + B * docLen / avgdl) + tf)
            score += idf * dfFactor
        }
        return score
    }

    /**
     * Find top-K commits most similar to the given diff text.
     * Returns commit messages ranked by BM25 relevance score.
     *
     * @param allCommits   full commit history
     * @param diffText     the current diff to match against
     * @param topK         number of results to return (default 5)
     * @return             list of (message, score) sorted by score descending
     */
    fun retrieveSimilarCommits(
        allCommits: List<String>,
        diffText: String,
        topK: Int = 5
    ): List<Pair<String, Double>> {
        if (allCommits.isEmpty() || diffText.isBlank()) return emptyList()

        val queryTerms = tokenize(diffText)
        if (queryTerms.isEmpty()) return emptyList()

        // Build document token lists
        val docTokensList = allCommits.map { tokenize(it) }
        val docLens = docTokensList.map { it.size.toDouble() }
        val avgdl = docLens.average()

        // Score each commit
        val scored = allCommits.mapIndexed { i, msg ->
            val score = scoreDoc(queryTerms, docTokensList[i], avgdl)
            Pair(msg, score)
        }

        // Return top-K with score > 0, fallback to first K if all scores are 0
        return scored
            .filter { it.second > 0.0 }
            .sortedByDescending { it.second }
            .take(topK)
            .ifEmpty { allCommits.take(topK).map { it to 0.0 } }
    }
}
