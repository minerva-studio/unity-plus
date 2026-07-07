using UnityEngine;
using UnityEngine.Events;

namespace Amlos.Control.Interact
{
    public sealed class Interactable : MonoBehaviour
    {
        public UnityEvent OnCheckEnable = new();

        /// <summary>
        /// Provides a method symbol for C# provider integration tests.
        /// </summary>
        public void Interact()
        {
        }
    }
}
