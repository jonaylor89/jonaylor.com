package com.jonaylor.saintjohn.data.remote

import com.jonaylor.saintjohn.BuildConfig
import com.jonaylor.saintjohn.data.remote.dto.WeatherResponse
import retrofit2.http.GET
import retrofit2.http.Query

interface WeatherApi {

    @GET("weather")
    suspend fun getCurrentWeather(
        @Query("q") city: String,
        @Query("appid") apiKey: String,
        @Query("units") units: String = "metric"
    ): WeatherResponse

    @GET("weather")
    suspend fun getCurrentWeatherByCoords(
        @Query("lat") latitude: Double,
        @Query("lon") longitude: Double,
        @Query("appid") apiKey: String,
        @Query("units") units: String = "metric"
    ): WeatherResponse

    companion object {
        const val BASE_URL = "https://api.openweathermap.org/data/2.5/"
        // Supplied by the local build environment; never checked into source.
        const val API_KEY = BuildConfig.OPENWEATHER_API_KEY
    }
}
