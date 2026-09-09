package com.hostai.backend;

import io.netty.channel.ChannelOption;
import java.time.Duration;
import java.util.concurrent.Executors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.task.VirtualThreadTaskExecutor;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.http.codec.ServerCodecConfigurer;
import org.springframework.web.reactive.config.BlockingExecutionConfigurer;
import org.springframework.web.reactive.config.WebFluxConfigurer;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;
import reactor.netty.http.client.HttpClient;

@Configuration(proxyBeanMethods = false)
public class BackendConfiguration implements WebFluxConfigurer {
    static final int MAX_BODY_BYTES = 256 * 1024;

    @Bean
    LocalOllamaEndpoint ollamaEndpoint(@Value("${hostai.ollama-url}") String url) {
        return LocalOllamaEndpoint.parse(url);
    }

    @Bean
    InferenceRegistry inferenceRegistry() { return new InferenceRegistry(); }

    @Bean(destroyMethod = "dispose")
    Scheduler inferenceScheduler() {
        return Schedulers.fromExecutorService(Executors.newThreadPerTaskExecutor(
                Thread.ofVirtual().name("hostai-inference-", 0).factory()));
    }

    @Bean
    WebClient ollamaClient(LocalOllamaEndpoint endpoint) {
        // A new connection per exchange makes ownership/cancellation explicit. No proxy,
        // redirects, automatic retry, model downloads, or discovery outside loopback.
        HttpClient transport = HttpClient.newConnection()
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 2_000)
                .followRedirect(false)
                .disableRetry(true)
                .responseTimeout(Duration.ofSeconds(60));
        return WebClient.builder()
                .baseUrl(endpoint.requestUrl().toString())
                .clientConnector(new ReactorClientHttpConnector(transport))
                .codecs(codecs -> codecs.defaultCodecs().maxInMemorySize(MAX_BODY_BYTES))
                .build();
    }

    @Override
    public void configureHttpMessageCodecs(ServerCodecConfigurer codecs) {
        codecs.defaultCodecs().maxInMemorySize(MAX_BODY_BYTES);
        codecs.defaultCodecs().enableLoggingRequestDetails(false);
    }

    @Override
    public void configureBlockingExecution(BlockingExecutionConfigurer configurer) {
        configurer.setExecutor(new VirtualThreadTaskExecutor("hostai-http-"));
        configurer.setControllerMethodPredicate(method -> true);
    }
}
