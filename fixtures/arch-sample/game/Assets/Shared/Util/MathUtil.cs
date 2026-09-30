namespace Game.Util
{
    public static class MathUtil
    {
        public static float Clamp01(float v) => v < 0 ? 0 : (v > 1 ? 1 : v);
    }
}
